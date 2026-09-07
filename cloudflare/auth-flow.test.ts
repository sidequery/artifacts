import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { symmetricDecrypt } from "better-auth/crypto";
import { startOidcFixture } from "../e2e/oidc-fixture";
import { startCelldAuthRuntime } from "../e2e/celld-auth-runtime";

let runtime: Miniflare;
let celldRuntime: Awaited<ReturnType<typeof startCelldAuthRuntime>> | undefined;
let fixture: Awaited<ReturnType<typeof startOidcFixture>>;
let browser: Browser;
let origin: string;
const clients: Client[] = [];
const authSecret = "auth-flow-test-only-secret-with-at-least-32-characters";
const counterClient = await readFile(new URL("../examples/counter.canvas.tsx", import.meta.url), "utf8");
const counterServer = await readFile(new URL("../examples/counter.canvas.server.ts", import.meta.url), "utf8");

beforeAll(async () => {
  fixture = await startOidcFixture();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  origin = `http://127.0.0.1:${port}`;
  const modulesRoot = join(import.meta.dir, "../dist/worker-app");
  const modules: Record<string, { type: "esm" | "wasm" | "text"; contents: string | Uint8Array<ArrayBuffer> }> = {};
  for (const name of await readdir(modulesRoot)) {
    if (name.endsWith(".js")) modules[name] = { type: "esm", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".html")) modules[name] = { type: "text", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
  }
  const configuration = {
    AUTH_MODE: "better-auth", ENVIRONMENT: "local", BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_ALLOWED_DOMAINS: "example.test",
    BETTER_AUTH_TRUSTED_IP_HEADER: "x-canvas-test-ip",
    BETTER_AUTH_OIDC_PROVIDERS: JSON.stringify([{ providerId: "company", discoveryUrl: `${fixture.origin}/.well-known/openid-configuration`, clientId: "canvas-test", clientSecret: "fixture-only-not-real-secret", scopes: ["openid", "profile", "email"], pkce: true }]),
  };
  if (process.env.CELLD_AUTH_INTEGRATION === "1") {
    celldRuntime = await startCelldAuthRuntime({ port, bindings: configuration });
    browser = await chromium.launch({ headless: true });
    return;
  }
  const bindings = Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, { type: "text" as const, value }]));
  runtime = new Miniflare({ cf: false, host: "127.0.0.1", port, workers: [{ config: {
    name: "canvas-auth-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot, modules },
    env: { ...bindings,
      AUTH_DB: { type: "d1", id: "canvas-auth-test", name: "canvas-auth" },
      LIBRARIES: { type: "durable-object", worker: "canvas-auth-test", exportName: "CanvasLibrary" },
      BACKENDS: { type: "durable-object", worker: "canvas-auth-test", exportName: "CanvasBackend" },
      LINKS: { type: "durable-object", worker: "canvas-auth-test", exportName: "ArtifactLinks" },
      SCRIPTS: { type: "durable-object", worker: "canvas-auth-test", exportName: "ScriptLibrary" },
      SCRIPT_BACKENDS: { type: "durable-object", worker: "canvas-auth-test", exportName: "ScriptBackend" },
      LOADER: { type: "worker-loader" }, ASSETS: { type: "assets" },
    },
    exports: { ArtifactLinks: { type: "durable-object", storage: "sqlite" }, ScriptLibrary: { type: "durable-object", storage: "sqlite" }, ScriptBackend: { type: "durable-object", storage: "sqlite" }, CanvasLibrary: { type: "durable-object", storage: "sqlite" }, CanvasBackend: { type: "durable-object", storage: "sqlite" } },
    assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" },
  }, dev: {} }] });
  await runtime.ready;
  const db = await runtime.getD1Database("AUTH_DB", "canvas-auth-test");
  for (const migration of (await readdir(join(import.meta.dir, "migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(join(import.meta.dir, "migrations", migration), "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").trim());
  }
  browser = await chromium.launch({ headless: true });
}, 90000);

afterAll(async () => {
  await Promise.all(clients.map(client => client.close()));
  await browser?.close();
  await runtime?.dispose();
  await celldRuntime?.close();
  await fixture?.close();
});

async function login(page: Page, name: string) {
  page.setDefaultTimeout(8000);
  try {
    await page.getByRole("button", { name: "Continue with company" }).click();
    await page.getByRole("button", { name, exact: true }).click();
  } catch (error) {
    throw new Error(`${String(error)}\nPage: ${new URL(page.url()).pathname}\n${await page.locator("body").innerText()}`);
  }
}

class TestOAuthProvider implements OAuthClientProvider {
  information?: OAuthClientInformationMixed;
  savedTokens?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  constructor(readonly redirectUrl: string, readonly scope = "canvas offline_access") {}
  get clientMetadata() { return { redirect_uris: [this.redirectUrl], client_name: "Canvas integration client", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: this.scope }; }
  state() { return "test-oauth-state"; }
  clientInformation() { return this.information; }
  saveClientInformation(information: OAuthClientInformationMixed) { this.information = information; }
  tokens() { return this.savedTokens; }
  saveTokens(tokens: OAuthTokens) { this.savedTokens = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

async function authorize(context: BrowserContext, user?: string, scope?: string) {
  let callback: URL | undefined;
  const requests: string[] = [];
  const oauthFetch: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(10000) });
      requests.push(`${init?.method ?? "GET"} ${path}: ${response.status}`);
      return response;
    } catch (error) { requests.push(`${path}: ${String(error)}`); throw error; }
  };
  const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { callback = new URL(request.url); return new Response("Authorized"); } });
  try {
    const provider = new TestOAuthProvider(`http://127.0.0.1:${receiver.port}/callback`, scope);
    expect(await auth(provider, { serverUrl: `${origin}/mcp`, scope: provider.scope, fetchFn: oauthFetch })).toBe("REDIRECT");
    const page = await context.newPage();
    await page.goto(provider.authorizationUrl!.href);
    if (user) await login(page, user);
    try { await page.getByRole("button", { name: "Allow", exact: true }).click(); }
    catch (error) { throw new Error(`${String(error)}\nPage: ${new URL(page.url()).pathname}\n${await page.locator("body").innerText()}`); }
    await page.waitForURL(`${provider.redirectUrl}?**`);
    expect(callback?.searchParams.get("state")).toBe("test-oauth-state");
    expect(callback?.searchParams.get("error")).toBeNull();
    expect(await auth(provider, { serverUrl: `${origin}/mcp`, scope: provider.scope, fetchFn: oauthFetch, authorizationCode: callback!.searchParams.get("code")! })).toBe("AUTHORIZED");
    await page.close();
    return provider;
  } catch (error) {
    throw new Error(`${String(error)}\n${requests.join("\n")}\n${celldRuntime?.logs().split("\n").filter(line => /ERROR|WARN| at |    at /.test(line)).join("\n") ?? ""}`);
  } finally { await receiver.stop(true); }
}

async function connect(provider: TestOAuthProvider, library = "private") {
  const client = new Client({ name: "auth-flow", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=test&library=${library}`), { authProvider: provider }));
  return client;
}
function payload(result: Awaited<ReturnType<Client["callTool"]>>) { return JSON.parse((result.content as { text: string }[])[0]!.text); }

test("discovery and anonymous surfaces require user login even on loopback", async () => {
  const denied = await fetch(`${origin}/mcp`);
  expect(denied.status, await denied.text() + (celldRuntime?.logs() ?? "")).toBe(401);
  expect(denied.headers.get("www-authenticate")).toContain("resource_metadata=");
  const concurrent = await Promise.all(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server/api/auth"].map(async path => {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(10000) });
    await response.text();
    return response.status;
  }));
  expect(concurrent).toEqual([200, 200]);
  const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  expect(metadata.resource).toBe(`${origin}/mcp`);
  expect(metadata.authorization_servers).toEqual([`${origin}/api/auth`]);
  const server = await (await fetch(`${origin}/.well-known/oauth-authorization-server/api/auth`)).json() as any;
  expect(server.issuer).toBe(`${origin}/api/auth`);
  expect(server.registration_endpoint).toBeString();
  expect((await fetch(origin, { redirect: "manual" })).status).toBe(302);
  for (const path of ["/api/gallery", "/api/source", "/gallery/preview", "/api/session"]) {
    expect((await fetch(origin + path, { headers: { "Cf-Access-Jwt-Assertion": "fake", "X-User-Id": "alice" } })).status).toBe(401);
  }
  const providers = await (await fetch(`${origin}/api/auth/providers`)).json();
  expect(providers).toEqual({ providers: [{ id: "company", name: "company" }] });
});

test("real OIDC and MCP OAuth share per-user gallery, source and database boundaries", async () => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    const aliceProvider = await authorize(aliceContext, "Alice");
    const bobPage = await bobContext.newPage();
    const previewRequests: string[] = [];
    bobPage.on("request", request => {
      if (["/gallery/preview", "/api/canvas/request"].includes(new URL(request.url()).pathname)) {
        previewRequests.push(`Started ${request.url()}`);
      }
    });
    bobPage.on("requestfailed", request => {
      if (["/gallery/preview", "/api/canvas/request"].includes(new URL(request.url()).pathname)) {
        previewRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
      }
    });
    bobPage.on("response", response => {
      if (["/gallery/preview", "/api/canvas/request"].includes(new URL(response.url()).pathname)) {
        previewRequests.push(`${response.url()}: ${response.status()}`);
      }
    });
    await bobPage.goto(`${origin}/?workspace=test`);
    await login(bobPage, "Bob");
    await bobPage.waitForURL(`${origin}/?workspace=test`);
    const bobProvider = await authorize(bobContext);
    const aliceSession = await (await aliceContext.request.get(`${origin}/api/session`)).json();
    const bobSession = await (await bobContext.request.get(`${origin}/api/session`)).json();
    expect(aliceSession.user.email).toBe("alice@example.test");
    expect(bobSession.user.email).toBe("bob@example.test");
    expect(decodeJwt(aliceProvider.savedTokens!.access_token).sub).toBe(aliceSession.user.id);
    expect(decodeJwt(bobProvider.savedTokens!.access_token).sub).toBe(bobSession.user.id);
    const publicKeys = await (await fetch(`${origin}/api/auth/jwks`)).json();
    await jwtVerify(aliceProvider.savedTokens!.access_token, createLocalJWKSet(publicKeys as any), { issuer: `${origin}/api/auth`, audience: `${origin}/mcp` });
    if (runtime) {
      const db = await runtime.getD1Database("AUTH_DB", "canvas-auth-test");
      const account = await db.prepare('select "accessToken" from "account" where "userId" = ?').bind(aliceSession.user.id).first<{ accessToken: string }>();
      const plaintext = await symmetricDecrypt({ key: authSecret, data: account!.accessToken });
      expect(account!.accessToken).not.toBe(plaintext);
      const info = await (await fetch(`${fixture.origin}/userinfo`, { headers: { Authorization: `Bearer ${plaintext}` } })).json() as { email: string };
      expect(info.email).toBe("alice@example.test");
    }
    const alice = await connect(aliceProvider), bob = await connect(bobProvider);
    const teamAlice = await connect(aliceProvider, "team"), teamBob = await connect(bobProvider, "team");
    let privateVersion = "";
    for (const client of [alice, bob, teamAlice]) {
      const result = await client.callTool({ name: "canvas_write", arguments: { name: "counter", contents: counterClient, server: counterServer } });
      expect(result.isError).not.toBe(true);
      if (client === alice) privateVersion = (result._meta as any).canvas.versionId;
    }
    const counter = async (client: Client, method = "GET") => {
      const result = await client.callTool({ name: "canvas_request", arguments: { name: "counter", request: { path: "/counter", method } } });
      expect(result.isError).not.toBe(true);
      return JSON.parse(atob((result.structuredContent as any).response.body)).value;
    };
    expect(await counter(alice, "POST")).toBe(1);
    expect(await counter(bob)).toBe(0);
    expect(await counter(teamAlice, "POST")).toBe(1);
    expect(await counter(teamBob, "POST")).toBe(2);
    expect(await counter(alice)).toBe(1);
    expect(await counter(bob)).toBe(0);
    expect((await bob.callTool({ name: "canvas_version", arguments: { version_id: privateVersion } })).isError).toBe(true);
    expect((await bob.callTool({ name: "canvas_restore", arguments: { version_id: privateVersion } })).isError).toBe(true);
    for (const path of [`/api/source?version=${privateVersion}`, `/gallery/preview?version=${privateVersion}`, `/api/source?library=team&version=${privateVersion}`]) {
      expect((await bobContext.request.get(`${origin}${path}&workspace=test&subject=${aliceSession.user.id}`)).status()).toBe(404);
    }
    const alicePage = await aliceContext.newPage();
    await alicePage.goto(`${origin}/?workspace=test`);
    await alicePage.getByRole("button", { name: "counter", exact: true }).click();
    await alicePage.frameLocator("iframe").getByText("Count: 1", { exact: true }).waitFor();
    await alicePage.frameLocator("iframe").getByRole("button", { name: "Increment" }).click();
    await alicePage.frameLocator("iframe").getByText("Count: 2", { exact: true }).waitFor();
    expect(await counter(alice)).toBe(2);
    expect(await counter(bob)).toBe(0);
    await bobPage.reload();
    await bobPage.getByLabel("Library", { exact: true }).selectOption("team");
    // Library selection navigates the whole page. Both documents contain a
    // counter button, so wait for the team document before interacting with it.
    await bobPage.waitForURL(url => url.searchParams.get("library") === "team");
    await bobPage.getByRole("button", { name: "counter", exact: true }).click();
    try {
      await bobPage.frameLocator("iframe").getByText("Count: 2", { exact: true }).waitFor();
    } catch (error) {
      const frame = bobPage.frameLocator("iframe");
      const body = await frame.locator("body").innerText({ timeout: 500 }).catch(() => "Preview body unavailable");
      throw new Error(`${String(error)}\nGallery: ${bobPage.url()}\nPreview: ${await bobPage.locator("iframe").getAttribute("src")}\n${body}\n${previewRequests.join("\n")}\n${celldRuntime?.logs().split("\n").filter(line => /ERROR|WARN| at |    at /.test(line)).join("\n") ?? ""}`);
    }
    expect((await aliceContext.request.post(`${origin}/api/canvas/request`, { headers: { Origin: "https://evil.example" }, data: {} })).status()).toBe(403);
    const token = aliceProvider.savedTokens!.access_token;
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token.slice(0, -10)}tampered00` } })).status).toBe(401);
    const cookie = (await aliceContext.cookies()).find(cookie => cookie.name.endsWith("session_token"))!;
    const sessionAsBearer = await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${cookie.value}` } });
    expect(sessionAsBearer.status, await sessionAsBearer.text()).toBe(401);
    const withoutScope = await authorize(bobContext, undefined, "openid");
    expect(decodeJwt(withoutScope.savedTokens!.access_token).scope).toBe("openid");
    const insufficient = await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${withoutScope.savedTokens!.access_token}` } });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(await auth(aliceProvider, { serverUrl: `${origin}/mcp` })).toBe("AUTHORIZED");
    expect(decodeJwt(aliceProvider.savedTokens!.access_token).sub).toBe(aliceSession.user.id);
    expect(payload(await alice.callTool({ name: "canvas_list", arguments: {} })).canvases).toHaveLength(1);
    await alicePage.getByRole("button", { name: "Sign out" }).click();
    await alicePage.getByRole("heading", { name: "Sign in to Canvas" }).waitFor();
    expect((await aliceContext.request.get(`${origin}/api/gallery`)).status()).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${aliceProvider.savedTokens!.access_token}` } })).status).toBe(401);
    expect(await counter(bob)).toBe(0);
  } finally { await aliceContext.close(); await bobContext.close(); }
}, 120000);

test("an authenticated provider outsider is denied team admission and password registration stays disabled", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await login(page, "Outsider");
    await page.waitForURL(url => url.origin === origin && url.searchParams.has("error"));
    expect((await context.request.get(`${origin}/api/session`)).status()).toBe(401);
    expect((await context.request.get(`${origin}/api/gallery?library=team`)).status()).toBe(401);
    expect((await context.request.post(`${origin}/api/auth/sign-up/email`, { headers: { Origin: origin }, data: { name: "Injected", email: "injected@example.test", password: "not-a-supported-signup" } })).status()).not.toBe(200);
  } finally { await context.close(); }
}, 30000);

test("standard MCP registration infers native redirects without relaxing Better Auth URI validation", async () => {
  const cases: { redirects: string[]; type?: string; expected?: string }[] = [
    { redirects: ["http://localhost:4787/callback"], expected: "native" },
    { redirects: ["http://127.0.0.1:4787/callback"], expected: "native" },
    { redirects: ["http://[::1]:4787/callback"], expected: "native" },
    { redirects: ["com.example.canvas:/callback"], expected: "native" },
    { redirects: ["https://client.example/callback"], expected: "web" },
    { redirects: ["https://client.example/callback"], type: "native", expected: "native" },
    { redirects: ["https://client.example/callback", "http://127.0.0.1:4787/callback"], expected: "native" },
    { redirects: ["http://localhost:4787/callback"], type: "web" },
    { redirects: ["http://client.example/callback"] },
    { redirects: ["http://localhost.evil.example/callback"] },
    { redirects: ["https://localhost/callback"] },
    { redirects: ["file:///callback"] },
    { redirects: ["javascript:alert(1)"] },
    { redirects: ["invalid-uri"] },
    { redirects: ["http://127.0.0.1:4787/callback", "http://evil.example/callback"] },
  ];
  for (const [index, item] of cases.entries()) {
    const response = await fetch(`${origin}/api/auth/oauth2/register`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-canvas-test-ip": `192.0.2.${index + 1}` },
      body: JSON.stringify({ client_name: "Registration contract", redirect_uris: item.redirects,
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope: "canvas",
        ...(item.type ? { application_type: item.type } : {}),
      }),
    });
    const body = await response.json() as { application_type?: string; error_description?: string };
    expect(response.status, `${JSON.stringify(item)} ${body.error_description ?? ""}`).toBe(item.expected ? 201 : 400);
    if (item.expected) expect(body.application_type).toBe(item.expected);
  }
});
