import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import {
  createDpopReplayStore, createInsufficientScopeError, enforceDpopBinding,
  isDpopBindingError, parseAccessTokenAuthorization, verifyJwsAccessToken,
} from "better-auth/oauth2";
import { mcp } from "@better-auth/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { decodeProtectedHeader, errors } from "jose";
import type { D1Database } from "@cloudflare/workers-types";
import { teamAllowsUser, teamProviderOptions, type TeamAuthEnvironment } from "./team-auth";

export type BetterAuthEnvironment = TeamAuthEnvironment & {
  AUTH_MODE?: string;
  AUTH_DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_TRUSTED_IP_HEADER?: string;
};
export type CanvasUser = { id: string; name: string; email: string; emailVerified: boolean };
export class CanvasAuthConfigurationError extends Error {}

function nativeRedirectHint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      ? ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      : url.protocol !== "https:";
  } catch { return false; }
}

export function authOrigin(env: BetterAuthEnvironment): string {
  if (!env.BETTER_AUTH_URL) throw new Error("Configure BETTER_AUTH_URL for this Canvas deployment");
  const url = new URL(env.BETTER_AUTH_URL);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("BETTER_AUTH_URL must be the deployment's HTTPS origin (HTTP loopback is allowed for development)");
  }
  return url.origin;
}

export function canvasAuthOptions(env: BetterAuthEnvironment, database: NonNullable<BetterAuthOptions["database"]> = env.AUTH_DB!) {
  const origin = authOrigin(env);
  if (!database) throw new Error("Configure the AUTH_DB binding and apply the auth database migrations");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("Configure BETTER_AUTH_SECRET with at least 32 random characters");
  const providers = teamProviderOptions(env);
  return {
    appName: "Canvas",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database,
    socialProviders: providers.socialProviders,
    account: { encryptOAuthTokens: true },
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      // Migrations own the schema. celld 0.4.1 rejects the table-valued PRAGMA
      // queries used by Better Auth's optional startup introspection.
      database: { validateSchema: false },
      ipAddress: { ipAddressHeaders: env.BETTER_AUTH_TRUSTED_IP_HEADER ? [env.BETTER_AUTH_TRUSTED_IP_HEADER] : [] },
    },
    user: {
      validateUserInfo({ user }) {
        if (!teamAllowsUser(env, user)) return { error: "access_denied", errorDescription: "Your account is not authorized for this team server." };
      },
    },
    hooks: {
      before: createAuthMiddleware(async ctx => {
        // OAuth-only MCP clients may omit OIDC's application_type field.
        // Infer native from their redirect, then let Better Auth validate every
        // URI. Explicit types and HTTPS-only web registrations stay unchanged.
        if (ctx.path !== "/oauth2/register" || ctx.body?.application_type !== undefined
          || !Array.isArray(ctx.body?.redirect_uris)) return;
        if (ctx.body.redirect_uris.some(nativeRedirectHint)) ctx.body.application_type = "native";
      }),
    },
    plugins: [
      ...(providers.plugins ?? []),
      // celld 0.4.1's WebCrypto cannot verify Ed25519 (Better Auth's default).
      // RS256 uses the native signing and verification paths on both runtimes.
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
      mcp({
        loginPage: "/sign-in", consentPage: "/consent", resource: `${origin}/mcp`,
        scopes: ["openid", "profile", "email", "offline_access", "canvas"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 300,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        allowPublicClientPrelogin: true,
        enforcePerClientResources: true,
      }),
    ],
  } satisfies BetterAuthOptions;
}

function instantiateAuth(env: BetterAuthEnvironment) { return betterAuth(canvasAuthOptions(env)); }
export type CanvasAuth = ReturnType<typeof instantiateAuth>;
export async function getCanvasAuth(env: BetterAuthEnvironment): Promise<CanvasAuth> {
  // Keep router/context state request-local: sharing an instance across
  // concurrent celld requests can leave its auth handlers waiting forever.
  let auth: CanvasAuth;
  try { auth = instantiateAuth(env); }
  catch (error) { throw new CanvasAuthConfigurationError(error instanceof Error ? error.message : "Invalid authentication configuration", { cause: error }); }
  // Provider discovery (and any schema check enabled by a deployment) must
  // finish in its originating request; workerd cancels I/O when it returns.
  try {
    const context = await auth.$context;
    await context.checkSchema?.();
  } catch (error) {
    console.error("Canvas authentication initialization failed", error);
    throw new CanvasAuthConfigurationError("Authentication is unavailable; verify provider configuration and auth database migrations", { cause: error });
  }
  return auth;
}

export function browserSignIn(request: Request): Response {
  const current = new URL(request.url);
  const returnTo = current.pathname + current.search;
  const login = `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
  if (request.method === "GET" && ["/", "/gallery"].includes(current.pathname)) {
    return new Response(null, { status: 302, headers: { Location: login, "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "Sign in to Canvas", loginUrl: login }, {
    status: 401, headers: { "X-Canvas-Auth": "better-auth", "Cache-Control": "no-store" },
  });
}

/** Browser sessions and OAuth access tokens resolve to the same Better Auth
 * user ID. Provider tokens and caller-supplied identity headers are never used
 * as Canvas authorization credentials. */
export async function authenticateBetterAuth(request: Request, env: BetterAuthEnvironment): Promise<CanvasUser | Response> {
  const auth = await getCanvasAuth(env);
  const context = await auth.$context;
  const origin = authOrigin(env);
  const isMcp = new URL(request.url).pathname === "/mcp";
  if (!isMcp) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return browserSignIn(request);
    if (!teamAllowsUser(env, session.user)) return Response.json({ error: "Your account is not authorized for this team server" }, { status: 403 });
    return session.user;
  }
  const resource = `${origin}/mcp`;
  try {
    const authorization = parseAccessTokenAuthorization(request.headers.get("Authorization"));
    if (!authorization?.token || authorization.scheme === "Unknown") throw new APIError("UNAUTHORIZED", { message: "User authorization required" });
    // jose reports malformed compact-token headers with TypeError. Limit that
    // classification to parsing so a JWKS/storage failure remains a server error.
    try { decodeProtectedHeader(authorization.token); }
    catch { throw new APIError("UNAUTHORIZED", { message: "Invalid access token" }); }
    const claims = await verifyJwsAccessToken(authorization.token, {
      // Read our own public keys through Better Auth, not a network request
      // back into this Worker. Key selection/rotation remains library-owned.
      jwksFetch: () => auth.api.getJwks(), jwksCacheKey: auth,
      verifyOptions: { issuer: `${origin}/api/auth`, audience: resource, requiredClaims: ["sub", "sid", "exp", "iat"] },
    });
    await enforceDpopBinding({
      payload: claims, authorization, proofJwt: request.headers.get("DPoP"),
      method: request.method, url: request.url,
      replayStore: createDpopReplayStore(context.internalAdapter),
    });
    if (typeof claims.scope !== "string" || !claims.scope.split(" ").includes("canvas")) throw createInsufficientScopeError(["canvas"]);
    if (typeof claims.sub !== "string" || !claims.sub || typeof claims.sid !== "string" || !claims.sid) throw new APIError("UNAUTHORIZED", { message: "A user session is required" });
    // JWT verification alone accepts a token until expiry after sign-out.
    // Check the attached session as well so both surfaces revoke together.
    const session = await context.adapter.findOne<{ userId: string; expiresAt: Date }>({
      model: "session", where: [{ field: "id", value: claims.sid }, { field: "userId", value: claims.sub }],
    });
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw new APIError("UNAUTHORIZED", { message: "Your user session has expired or was signed out" });
    const user = await context.internalAdapter.findUserById(claims.sub);
    if (!user) throw new APIError("UNAUTHORIZED", { message: "User no longer exists" });
    if (!teamAllowsUser(env, user)) return Response.json({ error: "Your account is not authorized for this team server" }, { status: 403 });
    return user;
  } catch (error) {
    if (isDpopBindingError(error)) error = new APIError("UNAUTHORIZED", { error: error.code, error_description: error.message });
    else if (error instanceof errors.JOSEError) error = new APIError("UNAUTHORIZED", { message: "Invalid or expired access token" });
    const challenge = createResourceServerChallenge(error, resource, { challengeScopes: ["canvas"] });
    if (!challenge) throw error;
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: challenge.message } }, {
      status: challenge.statusCode, headers: { ...challenge.headers, "Cache-Control": "no-store" },
    });
  }
}
