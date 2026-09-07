import { beforeAll, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, type FetchImplementation, type KeyLike } from "jose";
import { createAuthenticator, type AuthEnvironment, type Identity } from "./auth";

const domain = "canvas-team.cloudflareaccess.com";
const issuer = `https://${domain}`;
const audience = "canvas-access-audience";
const keyId = "access-test-key";
const env: AuthEnvironment = { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: audience };
let privateKey: KeyLike;
let jwks: { keys: Record<string, unknown>[] };
let jwksRequests: string[];
let authenticate: ReturnType<typeof createAuthenticator>;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: keyId, alg: "RS256", use: "sig" }] };
  jwksRequests = [];
  const fetchJwks: FetchImplementation = async (url, options) => {
    jwksRequests.push(url);
    expect(options.method).toBe("GET");
    return Response.json(jwks);
  };
  authenticate = createAuthenticator(fetchJwks);
});

function request(assertion?: string, url = "https://canvas.example.com/mcp"): Request {
  return new Request(url, assertion ? { headers: { "Cf-Access-Jwt-Assertion": assertion } } : undefined);
}

async function token(input: { issuer?: string; audience?: string; subject?: string; issuedAt?: number; expiresAt?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(input.issuer ?? issuer)
    .setAudience(input.audience ?? audience)
    .setSubject(input.subject ?? "account-member-123")
    .setIssuedAt(input.issuedAt ?? now)
    .setExpirationTime(input.expiresAt ?? now + 60)
    .sign(privateKey);
}

function asResponse(result: Identity | Response): Response {
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

test("accepts a valid RS256 Cloudflare Access assertion from the configured JWKS", async () => {
  const result = await authenticate(request(await token()), env);
  expect(result).toEqual({ subject: "account-member-123", authority: issuer });
  expect(jwksRequests).toEqual([`${issuer}/cdn-cgi/access/certs`]);
});

test("rejects wrong audience, wrong issuer, expired, and tampered signed assertions", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    await token({ audience: "another-audience" }),
    await token({ issuer: "https://another-team.cloudflareaccess.com" }),
    await token({ issuedAt: now - 120, expiresAt: now - 60 }),
  ];
  const valid = await token();
  const pieces = valid.split(".");
  pieces[2] = `${pieces[2]![0] === "A" ? "B" : "A"}${pieces[2]!.slice(1)}`;
  cases.push(pieces.join("."));

  for (const assertion of cases) {
    const response = asResponse(await authenticate(request(assertion), env));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid Cloudflare Access assertion" });
  }
});

test("requires the assertion and fails closed when Access configuration is absent or malformed", async () => {
  const absent = asResponse(await authenticate(request(), env));
  expect(absent.status).toBe(401);
  expect(await absent.json()).toEqual({ error: "Cloudflare Access sign-in required" });

  for (const config of [
    {},
    { ACCESS_TEAM_DOMAIN: domain },
    { ACCESS_AUD: audience },
    { ACCESS_TEAM_DOMAIN: "canvas.example.com", ACCESS_AUD: audience },
    { ACCESS_TEAM_DOMAIN: "Canvas-Team.cloudflareaccess.com", ACCESS_AUD: audience },
  ]) {
    const response = asResponse(await authenticate(request(await token()), config));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD, then enable Cloudflare Access with managed OAuth for this Worker." });
  }
});

test("local bypass requires the explicit local environment and an exact loopback hostname", async () => {
  for (const url of ["http://localhost:4785/mcp", "http://127.0.0.1:4785/mcp", "http://[::1]:4785/mcp"]) {
    expect(await authenticate(request(undefined, url), { ENVIRONMENT: "local" })).toEqual({ subject: "local", authority: "local" });
  }
  for (const url of ["https://canvas.example.com/mcp", "http://localhost.example.com/mcp", "http://127.0.0.2/mcp"]) {
    const response = asResponse(await authenticate(request(undefined, url), { ENVIRONMENT: "local" }));
    expect(response.status).toBe(503);
  }
  const productionLoopback = asResponse(await authenticate(request(undefined, "http://127.0.0.1:4785/mcp"), {}));
  expect(productionLoopback.status).toBe(503);
});
