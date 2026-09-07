import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { authOrigin, canvasAuthOptions } from "./better-auth";
import { teamAllowsUser, teamProviderOptions } from "./team-auth";

const secret = "0123456789abcdef0123456789abcdef";

test("team provider configuration passes native social and generic OAuth options through without a provider allowlist", () => {
  const socialProviders = {
    github: { clientId: "github-id", clientSecret: "github-secret" },
    microsoft: { clientId: "microsoft-id", clientSecret: "microsoft-secret", tenantId: "tenant" },
  };
  const oidcProviders = [{
    providerId: "company-sso",
    name: "Company SSO",
    clientId: "oidc-id",
    clientSecret: "oidc-secret",
    discoveryUrl: "https://identity.example/.well-known/openid-configuration",
  }];
  const configured = teamProviderOptions({
    BETTER_AUTH_SOCIAL_PROVIDERS: JSON.stringify(socialProviders),
    BETTER_AUTH_OIDC_PROVIDERS: JSON.stringify(oidcProviders),
  });

  expect(configured.socialProviders).toEqual(socialProviders);
  expect(configured.plugins).toHaveLength(1);
  expect(configured.plugins?.[0]).toMatchObject({ id: "generic-oauth", options: { config: oidcProviders } });
  expect(teamProviderOptions({})).toEqual({ socialProviders: {}, plugins: [] });
});

test("team provider configuration rejects malformed JSON and wrong container shapes", () => {
  expect(() => teamProviderOptions({ BETTER_AUTH_SOCIAL_PROVIDERS: "{" })).toThrow("BETTER_AUTH_SOCIAL_PROVIDERS must contain valid JSON");
  expect(() => teamProviderOptions({ BETTER_AUTH_OIDC_PROVIDERS: "{" })).toThrow("BETTER_AUTH_OIDC_PROVIDERS must contain valid JSON");
  expect(() => teamProviderOptions({ BETTER_AUTH_SOCIAL_PROVIDERS: "[]" })).toThrow("must be an object");
  expect(() => teamProviderOptions({ BETTER_AUTH_SOCIAL_PROVIDERS: "null" })).toThrow("must be an object");
  expect(() => teamProviderOptions({ BETTER_AUTH_OIDC_PROVIDERS: "{}" })).toThrow("must be an array");
});

test("team admission requires a verified allowlisted email or domain unless the deployment explicitly allows all provider users", () => {
  const env = {
    BETTER_AUTH_ALLOWED_EMAILS: "OWNER@EXAMPLE.COM, teammate@elsewhere.test",
    BETTER_AUTH_ALLOWED_DOMAINS: "Example.org internal.test",
  };
  expect(teamAllowsUser(env, { email: "owner@example.com", emailVerified: true })).toBe(true);
  expect(teamAllowsUser(env, { email: "Person@EXAMPLE.ORG", emailVerified: true })).toBe(true);
  expect(teamAllowsUser(env, { email: "outsider@example.net", emailVerified: true })).toBe(false);
  expect(teamAllowsUser(env, { email: "owner@example.com", emailVerified: false })).toBe(false);
  expect(teamAllowsUser(env, { email: "owner@example.com" })).toBe(false);
  for (const email of ["example.org", "@example.org", "a@@example.org", "a b@example.org"]) {
    expect(teamAllowsUser(env, { email, emailVerified: true })).toBe(false);
  }
  expect(teamAllowsUser({ BETTER_AUTH_ALLOW_ALL_USERS: "true" }, {})).toBe(true);
  expect(teamAllowsUser({ BETTER_AUTH_ALLOW_ALL_USERS: "TRUE" }, { email: "owner@example.com", emailVerified: true })).toBe(false);
});

test("auth origin accepts HTTPS and explicit loopback development origins while rejecting unsafe or non-origin URLs", () => {
  expect(authOrigin({ BETTER_AUTH_URL: "https://canvas.example" })).toBe("https://canvas.example");
  expect(authOrigin({ BETTER_AUTH_URL: "https://canvas.example:8443" })).toBe("https://canvas.example:8443");
  for (const url of ["http://localhost:4785", "http://127.0.0.1:4785", "http://[::1]:4785"]) {
    expect(authOrigin({ BETTER_AUTH_URL: url })).toBe(url);
  }
  for (const url of [
    "http://canvas.example",
    "http://localhost.example:4785",
    "https://user:password@canvas.example",
    "https://canvas.example/auth",
    "https://canvas.example?tenant=one",
    "https://canvas.example#auth",
  ]) expect(() => authOrigin({ BETTER_AUTH_URL: url })).toThrow("must be the deployment's HTTPS origin");
  expect(() => authOrigin({})).toThrow("Configure BETTER_AUTH_URL");
});

test("Canvas auth options keep password auth disabled and configure the bounded MCP OAuth server", () => {
  const database = new Database(":memory:");
  try {
    const options = canvasAuthOptions({
      BETTER_AUTH_URL: "https://canvas.example",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_ALLOW_ALL_USERS: "true",
    }, database);
    expect(options).toMatchObject({
      appName: "Canvas",
      baseURL: "https://canvas.example",
      basePath: "/api/auth",
      emailAndPassword: { enabled: false },
      rateLimit: { enabled: true, storage: "database" },
    });
    const oauth = options.plugins?.find(plugin => plugin.id === "oauth-provider") as { options?: Record<string, unknown> } | undefined;
    expect(oauth?.options).toMatchObject({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email", "offline_access", "canvas"],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      allowPublicClientPrelogin: true,
      enforcePerClientResources: true,
    });
  } finally {
    database.close();
  }

  expect(() => canvasAuthOptions({ BETTER_AUTH_URL: "https://canvas.example", BETTER_AUTH_SECRET: secret }, undefined as never)).toThrow("AUTH_DB");
  expect(() => canvasAuthOptions({ BETTER_AUTH_URL: "https://canvas.example", BETTER_AUTH_SECRET: "too-short" }, {} as never)).toThrow("at least 32");
});
