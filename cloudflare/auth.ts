import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTVerifyGetKey } from "jose";

export type AuthEnvironment = {
  ENVIRONMENT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};
export type Identity = { subject: string; authority: string };

export function createAuthenticator(jwksFetch?: FetchImplementation) {
  const keySets = new Map<string, JWTVerifyGetKey>();
  return async (request: Request, env: AuthEnvironment): Promise<Identity | Response> => {
    const url = new URL(request.url);
    // Only the explicitly selected local environment can skip Access, and only
    // on loopback. A production deployment with missing settings stays closed.
    if (env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return { subject: "local", authority: "local" };
    }
    if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) {
      return Response.json({ error: "Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD, then enable Cloudflare Access with managed OAuth for this Worker." }, { status: 503 });
    }
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) return Response.json({ error: "Cloudflare Access sign-in required" }, { status: 401 });
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let keys = keySets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), jwksFetch ? { [customFetch]: jwksFetch } : undefined);
      keySets.set(issuer, keys);
    }
    try {
      // Managed OAuth forwards this same signed assertion after resolving the
      // client's opaque token. Never trust an email/header or decode-only JWT.
      const { payload } = await jwtVerify(assertion, keys, {
        issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing identity");
      return { subject: payload.sub, authority: issuer };
    } catch {
      return Response.json({ error: "Invalid Cloudflare Access assertion" }, { status: 401 });
    }
  };
}

export const authenticate = createAuthenticator();
