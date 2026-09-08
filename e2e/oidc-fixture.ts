import { SignJWT, exportJWK, generateKeyPair } from "jose";

const CLIENT_ID = "artifact-test";
const CLIENT_SECRET = "fixture-only-not-real-secret";
const KEY_ID = "artifact-oidc-fixture";

const USERS = {
  "test-alice": { id: "test-alice", email: "alice@example.test", name: "Alice" },
  "test-bob": { id: "test-bob", email: "bob@example.test", name: "Bob" },
  "test-outsider": { id: "test-outsider", email: "outsider@outside.test", name: "Outsider" },
} as const;

type FixtureUser = (typeof USERS)[keyof typeof USERS];
type Authorization = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  scope: string;
  user: FixtureUser;
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, { Pragma: "no-cache" });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

function isRegisteredRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && url.username === ""
      && url.password === ""
      && url.pathname === "/api/auth/callback/company"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function validateAuthorization(params: URLSearchParams): string | null {
  if (single(params, "response_type") !== "code") return "response_type must be code";
  if (single(params, "client_id") !== CLIENT_ID) return "unknown client_id";
  const redirectUri = single(params, "redirect_uri");
  if (!redirectUri || !isRegisteredRedirect(redirectUri)) return "redirect_uri is not registered";
  if (!single(params, "state")) return "state is required";
  if (!single(params, "nonce")) return "nonce is required";
  if (single(params, "code_challenge_method") !== "S256") return "code_challenge_method must be S256";
  if (!single(params, "code_challenge")) return "code_challenge is required";
  const scope = single(params, "scope");
  if (!scope?.split(/\s+/).includes("openid")) return "openid scope is required";
  return null;
}

function authorizationPage(params: URLSearchParams): Response {
  const hidden = [...params.entries()]
    .filter(([name]) => name !== "user")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const buttons = Object.values(USERS)
    .map(user => `<button type="submit" name="user" value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</button>`)
    .join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Fixture sign in</title></head><body><main><h1>Choose an account</h1><form method="post" action="/authorize">${hidden}${buttons}</form></main></body></html>`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'none'; form-action 'self' http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function basicCredentials(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function s256(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function signIdToken(
  privateKey: CryptoKey,
  issuer: string,
  authorization: Authorization,
): Promise<string> {
  return new SignJWT({
    email: authorization.user.email,
    email_verified: true,
    name: authorization.user.name,
    nonce: authorization.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(authorization.clientId)
    .setSubject(authorization.user.id)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

export async function startOidcFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = {
    ...await exportJWK(keys.publicKey),
    alg: "RS256",
    kid: KEY_ID,
    use: "sig",
  };
  const authorizationCodes = new Map<string, Authorization>();
  const accessTokens = new Map<string, FixtureUser>();
  let origin = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          userinfo_endpoint: `${origin}/userinfo`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "profile", "email"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (request.method === "GET" && url.pathname === "/jwks") return json({ keys: [publicJwk] });

      if (url.pathname === "/authorize" && request.method === "GET") {
        const error = validateAuthorization(url.searchParams);
        return error ? oauthError("invalid_request", error) : authorizationPage(url.searchParams);
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        const form = await request.formData();
        const params = new URLSearchParams();
        for (const [name, value] of form.entries()) {
          if (name !== "user" && typeof value === "string") params.append(name, value);
        }
        const error = validateAuthorization(params);
        if (error) return oauthError("invalid_request", error);
        const selected = form.getAll("user");
        const userId = selected.length === 1 && typeof selected[0] === "string" ? selected[0] : "";
        const user = USERS[userId as keyof typeof USERS];
        if (!user) return oauthError("access_denied", "a fixture user must be selected");

        const code = crypto.randomUUID();
        authorizationCodes.set(code, {
          clientId: single(params, "client_id")!,
          redirectUri: single(params, "redirect_uri")!,
          codeChallenge: single(params, "code_challenge")!,
          nonce: single(params, "nonce")!,
          scope: single(params, "scope")!,
          user,
        });
        const redirect = new URL(single(params, "redirect_uri")!);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", single(params, "state")!);
        return Response.redirect(redirect, 302);
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const authorizationHeader = request.headers.get("Authorization");
        const basic = basicCredentials(authorizationHeader);
        if (authorizationHeader && !basic) return oauthError("invalid_client", "client authentication failed", 401);
        const clientId = basic?.clientId ?? single(form, "client_id");
        const clientSecret = basic?.clientSecret ?? single(form, "client_secret");
        if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
          return oauthError("invalid_client", "client authentication failed", 401);
        }
        if (single(form, "grant_type") !== "authorization_code") {
          return oauthError("unsupported_grant_type", "grant_type must be authorization_code");
        }
        const code = single(form, "code");
        if (!code) return oauthError("invalid_grant", "authorization code is required");
        const authorization = authorizationCodes.get(code);
        if (!authorization) return oauthError("invalid_grant", "authorization code is invalid or already used");
        authorizationCodes.delete(code);
        if (clientId !== authorization.clientId) return oauthError("invalid_grant", "client_id does not match authorization code");
        if (single(form, "redirect_uri") !== authorization.redirectUri) {
          return oauthError("invalid_grant", "redirect_uri does not match authorization code");
        }
        const verifier = single(form, "code_verifier");
        if (!verifier || await s256(verifier) !== authorization.codeChallenge) {
          return oauthError("invalid_grant", "PKCE verification failed");
        }

        const accessToken = crypto.randomUUID();
        accessTokens.set(accessToken, authorization.user);
        return json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          scope: authorization.scope,
          id_token: await signIdToken(keys.privateKey, origin, authorization),
        }, 200, { Pragma: "no-cache" });
      }

      if (url.pathname === "/userinfo" && request.method === "GET") {
        const authorization = request.headers.get("Authorization");
        const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
        const user = token ? accessTokens.get(token) : undefined;
        if (!user) return oauthError("invalid_token", "access token is invalid", 401);
        return json({ sub: user.id, email: user.email, email_verified: true, name: user.name });
      }

      if (["/authorize", "/token", "/userinfo", "/jwks", "/.well-known/openid-configuration"].includes(url.pathname)) {
        const allow = url.pathname === "/authorize" ? "GET, POST" : url.pathname === "/token" ? "POST" : "GET";
        return new Response(null, { status: 405, headers: { Allow: allow } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    close: () => server.stop(true),
  };
}
