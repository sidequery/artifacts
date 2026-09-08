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
const counterClient = await readFile(new URL("../examples/counter.artifact.tsx", import.meta.url), "utf8");
const counterServer = await readFile(new URL("../examples/counter.artifact.server.ts", import.meta.url), "utf8");

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
    BETTER_AUTH_TRUSTED_IP_HEADER: "x-artifact-test-ip",
    BETTER_AUTH_OIDC_PROVIDERS: JSON.stringify([{ providerId: "company", discoveryUrl: `${fixture.origin}/.well-known/openid-configuration`, clientId: "artifact-test", clientSecret: "fixture-only-not-real-secret", scopes: ["openid", "profile", "email"], pkce: true }]),
  };
  if (process.env.CELLD_AUTH_INTEGRATION === "1") {
    celldRuntime = await startCelldAuthRuntime({ port, bindings: configuration });
    browser = await chromium.launch({ headless: true });
    return;
  }
  const bindings = Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, { type: "text" as const, value }]));
  runtime = new Miniflare({ cf: false, host: "127.0.0.1", port, workers: [{ config: {
    name: "artifacts-auth-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot, modules },
    env: { ...bindings,
      AUTH_DB: { type: "d1", id: "artifacts-auth-test", name: "artifacts-auth" },
      LIBRARIES: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ArtifactLibrary" },
      BACKENDS: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ArtifactBackend" },
      LINKS: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ArtifactLinks" },
      SCRIPTS: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ScriptLibrary" },
      SCRIPT_BACKENDS: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ScriptBackend" },
      FILE_BACKENDS: { type: "durable-object", worker: "artifacts-auth-test", exportName: "ArtifactFiles" },
      FILES: { type: "r2", name: "ownership-files" },
      LOADER: { type: "worker-loader" }, ASSETS: { type: "assets" },
    },
    exports: { ArtifactFiles: { type: "durable-object", storage: "sqlite" }, ArtifactLinks: { type: "durable-object", storage: "sqlite" }, ScriptLibrary: { type: "durable-object", storage: "sqlite" }, ScriptBackend: { type: "durable-object", storage: "sqlite" }, ArtifactLibrary: { type: "durable-object", storage: "sqlite" }, ArtifactBackend: { type: "durable-object", storage: "sqlite" } },
    assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" },
  }, dev: {} }] });
  await runtime.ready;
  const db = await runtime.getD1Database("AUTH_DB", "artifacts-auth-test");
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

// Each simulated browser gets its own client IP, as it already gets its own
// cookies. Keep the real rate limiter enabled without sharing its bucket
// across unrelated test users and scenarios.
let browserClient = 0;
const browserIPs = new WeakMap<BrowserContext, string>();
async function newBrowserContext() {
  const ip = `198.51.100.${++browserClient}`;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-artifact-test-ip": ip } });
  browserIPs.set(context, ip);
  return context;
}

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
  constructor(readonly redirectUrl: string, readonly scope = "artifacts offline_access") {}
  get clientMetadata() { return { redirect_uris: [this.redirectUrl], client_name: "Artifact integration client", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: this.scope }; }
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
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-artifact-test-ip", browserIPs.get(context)!);
      const response = await fetch(input, { ...init, headers, signal: AbortSignal.timeout(10000) });
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
  const aliceContext = await newBrowserContext();
  const bobContext = await newBrowserContext();
  try {
    const aliceProvider = await authorize(aliceContext, "Alice");
    const bobPage = await bobContext.newPage();
    const previewRequests: string[] = [];
    bobPage.on("request", request => {
      if (["/gallery/preview", "/api/artifact/request"].includes(new URL(request.url()).pathname)) {
        previewRequests.push(`Started ${request.url()}`);
      }
    });
    bobPage.on("requestfailed", request => {
      if (["/gallery/preview", "/api/artifact/request"].includes(new URL(request.url()).pathname)) {
        previewRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
      }
    });
    bobPage.on("response", response => {
      if (["/gallery/preview", "/api/artifact/request"].includes(new URL(response.url()).pathname)) {
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
      const db = await runtime.getD1Database("AUTH_DB", "artifacts-auth-test");
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
      const result = await client.callTool({ name: "artifact_write", arguments: { name: "counter", contents: counterClient, server: counterServer } });
      expect(result.isError).not.toBe(true);
      if (client === alice) privateVersion = (result._meta as any).artifact.versionId;
    }
    const counter = async (client: Client, method = "GET") => {
      const result = await client.callTool({ name: "artifact_request", arguments: { name: "counter", request: { path: "/counter", method } } });
      expect(result.isError).not.toBe(true);
      return JSON.parse(atob((result.structuredContent as any).response.body)).value;
    };
    expect(await counter(alice, "POST")).toBe(1);
    expect(await counter(bob)).toBe(0);
    expect(await counter(teamAlice, "POST")).toBe(1);
    expect(await counter(teamBob, "POST")).toBe(2);
    expect(await counter(alice)).toBe(1);
    expect(await counter(bob)).toBe(0);
    expect((await bob.callTool({ name: "artifact_version", arguments: { version_id: privateVersion } })).isError).toBe(true);
    expect((await bob.callTool({ name: "artifact_restore", arguments: { version_id: privateVersion } })).isError).toBe(true);
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
    expect((await aliceContext.request.post(`${origin}/api/artifact/request`, { headers: { Origin: "https://evil.example" }, data: {} })).status()).toBe(403);
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
    expect(payload(await alice.callTool({ name: "artifact_list", arguments: {} })).artifacts).toHaveLength(1);
    await alicePage.getByRole("button", { name: "Sign out" }).click();
    await alicePage.getByRole("heading", { name: "Sign in to Artifact" }).waitFor();
    expect((await aliceContext.request.get(`${origin}/api/gallery`)).status()).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${aliceProvider.savedTokens!.access_token}` } })).status).toBe(401);
    expect(await counter(bob)).toBe(0);
  } finally { await aliceContext.close(); await bobContext.close(); }
}, 120000);

test("an authenticated provider outsider is denied team admission and password registration stays disabled", async () => {
  const context = await newBrowserContext();
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
    { redirects: ["com.example.artifacts:/callback"], expected: "native" },
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
      method: "POST", headers: { "Content-Type": "application/json", "x-artifact-test-ip": `192.0.2.${index + 1}` },
      body: JSON.stringify({ client_name: "Registration contract", redirect_uris: item.redirects,
        token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope: "artifacts",
        ...(item.type ? { application_type: item.type } : {}),
      }),
    });
    const body = await response.json() as { application_type?: string; error_description?: string };
    expect(response.status, `${JSON.stringify(item)} ${body.error_description ?? ""}`).toBe(item.expected ? 201 : 400);
    if (item.expected) expect(body.application_type).toBe(item.expected);
  }
});

test("ownership transfer preserves live resources and revokes former library access across HTTP and MCP", async () => {
  const aliceContext = await newBrowserContext(), bobContext = await newBrowserContext();
  try {
    const aliceProvider = await authorize(aliceContext, "Alice"), bobProvider = await authorize(bobContext, "Bob");
    const alice = await connect(aliceProvider), bob = await connect(bobProvider), teamBob = await connect(bobProvider, "team");
    const tool = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result;
    };
    const move = (context: BrowserContext, kind: string, name: string, from: string, library: string) => context.request.post(`${origin}/api/library/move?workspace=test&library=${from}`, { data: { kind, name, library } });
    const decode = (result: any) => JSON.parse(atob(result.structuredContent.response.body));
    const artifact = "ownership-artifact", script = "ownership-script";
    const project = { files: { "helper.ts": "export const retained = 17;" }, dependencies: {} };
    const created = await tool(alice, "artifact_write", { name: artifact, slug: artifact, contents: counterClient, server: counterServer, project });
    const version = (created._meta as any).artifact.versionId;
    const scriptSource = 'export default { fetch(request: Request, env: ScriptEnv) { env.sql.exec("create table if not exists counted(n integer)"); if(request.method === "POST") env.sql.exec("insert into counted values(1)"); return Response.json({count:env.sql.exec("select count(*) as n from counted").one().n,secret:env.secrets.TOKEN ?? null}); }}';
    await tool(alice, "script_write", { name: script, contents: scriptSource, project });
    const scriptVersion = payload(await tool(alice, "script_history", { name: script })).versions[0].id;
    await tool(alice, "script_secrets", { name: script, secrets: { TOKEN: "transfer-retained" } });
    expect(decode(await tool(alice, "artifact_request", { name: artifact, request: { path: "/counter", method: "POST" } })).value).toBe(1);
    expect(decode(await tool(alice, "script_run", { name: script, request: { path: "/", method: "POST" } }))).toEqual({ count: 1, secret: "transfer-retained" });
    for (const [kind, name] of [["artifact", artifact], ["script", script]]) {
      await tool(alice, `${kind}_schedule`, { name, action: "set", interval_seconds: 3600, request: { path: kind === "artifact" ? "/counter" : "/", method: "POST" } });
      await tool(alice, `${kind}_schedule`, { name, action: "pause" });
    }
    const grant = (await tool(alice, "artifact_files", { name: artifact, request: { operation: "upload", name: "retained.txt", size: 8, type: "text/plain" } })).structuredContent as any;
    expect((await fetch(grant.result.url, { method: "PUT", body: "retained" })).status).toBe(201);
    const oldDownload = (await tool(alice, "artifact_files", { name: artifact, request: { operation: "download", id: grant.result.file.id } })).structuredContent as any;
    expect((await bobContext.request.get(`${origin}/${artifact}`)).status()).toBe(404);
    expect((await move(bobContext, "artifact", artifact, "private", "team")).status()).toBe(404);
    for (const [kind, name] of [["artifact", artifact], ["script", script]]) {
      const response = await move(aliceContext, kind!, name!, "private", "team");
      expect(response.status(), await response.text()).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, kind, name, libraryScope: "team" });
    }
    expect((await bobContext.request.get(`${origin}/${artifact}`)).status()).toBe(200);
    expect(await (await fetch(oldDownload.result.url)).text()).toBe("retained");
    expect(payload(await tool(teamBob, "artifact_version", { version_id: version })).source).toBe(counterClient);
    expect(payload(await tool(teamBob, "script_version", { version_id: scriptVersion })).source).toBe(scriptSource);
    expect((await alice.callTool({ name: "artifact_version", arguments: { version_id: version } })).isError).toBe(true);
    expect((await alice.callTool({ name: "script_version", arguments: { version_id: scriptVersion } })).isError).toBe(true);
    for (const request of [{ operation: "upload", name: "denied.txt", size: 1, type: "text/plain" }, { operation: "download", id: grant.result.file.id }]) {
      expect((await alice.callTool({ name: "artifact_files", arguments: { version_id: version, request } })).isError).toBe(true);
    }
    expect((await alice.callTool({ name: "artifact_edit", arguments: { name: artifact, edits: [{ old_text: "Counter", new_text: "Forbidden" }] } })).isError).toBe(true);
    expect((await alice.callTool({ name: "script_secrets", arguments: { name: script, secrets: { TOKEN: "forbidden" } } })).isError).toBe(true);
    for (const [kind, name, id] of [["artifact", artifact, version], ["script", script, scriptVersion]]) {
      const source = await bobContext.request.get(`${origin}/api/source?workspace=test&library=team&kind=${kind}&version=${id}&format=json`);
      expect(source.status()).toBe(200);
      expect((await source.json()).project.files).toEqual(project.files);
      expect((await aliceContext.request.get(`${origin}/api/source?workspace=test&kind=${kind}&version=${id}`)).status()).toBe(404);
      const schedule = payload(await tool(teamBob, `${kind}_schedule`, { name }));
      expect(schedule.schedule).toMatchObject({ paused: true, interval_seconds: 3600 });
      await tool(teamBob, `${kind}_schedule`, { name, action: "run_now" });
      expect(payload(await tool(teamBob, `${kind}_runs`, { name })).runs.length).toBeGreaterThan(0);
    }
    expect(decode(await tool(teamBob, "artifact_request", { name: artifact, request: { path: "/counter" } })).value).toBe(2);
    expect(decode(await tool(teamBob, "script_run", { name: script, request: { path: "/" } }))).toEqual({ count: 2, secret: "transfer-retained" });
    const files = (await tool(teamBob, "artifact_files", { version_id: version, request: { operation: "list" } })).structuredContent as any;
    expect(files.result.files[0].id).toBe(grant.result.file.id);
    for (const [kind, name, id] of [["artifact", artifact, version], ["script", script, scriptVersion]]) {
      await tool(teamBob, `${kind}_edit`, { name, file: "helper.ts", edits: [{ old_text: "17", new_text: "18" }] });
      await tool(teamBob, `${kind}_restore`, { ...(kind === "script" ? { name } : {}), version_id: id });
    }
    expect(decode(await tool(teamBob, "artifact_request", { name: artifact, request: { path: "/counter" } })).value).toBe(2);
    expect(decode(await tool(teamBob, "script_run", { name: script, request: { path: "/" } }))).toEqual({ count: 2, secret: "transfer-retained" });
    const teamGallery = await (await bobContext.request.get(`${origin}/api/gallery?workspace=test&library=team`)).json();
    expect(teamGallery.capabilities.moves).toBe(true);
    for (const name of [artifact, script]) expect(teamGallery.artifacts.find((item: any) => item.name === name)).toMatchObject({ url: `${origin}/${name}`, access: "private" });
    // Team -> Bob's private library changes ownership, including the creator's
    // URL and historical-version rights; it does not change URL access mode.
    for (const [kind, name] of [["artifact", artifact], ["script", script]]) expect((await move(bobContext, kind!, name!, "team", "private")).status()).toBe(200);
    expect((await aliceContext.request.get(`${origin}/${artifact}`)).status()).toBe(404);
    expect((await bobContext.request.get(`${origin}/${artifact}`)).status()).toBe(200);
    expect((await aliceContext.request.get(`${origin}/${script}`)).status()).toBe(404);
    expect((await bobContext.request.get(`${origin}/${script}`)).status()).toBe(200);
    expect((await teamBob.callTool({ name: "artifact_version", arguments: { version_id: version } })).isError).toBe(true);
    expect((await teamBob.callTool({ name: "script_version", arguments: { version_id: scriptVersion } })).isError).toBe(true);
    expect(payload(await tool(bob, "artifact_version", { version_id: version })).source).toBe(counterClient);
    expect(payload(await tool(bob, "script_version", { version_id: scriptVersion })).source).toBe(scriptSource);
    expect(decode(await tool(bob, "script_run", { name: script, request: { path: "/" } }))).toEqual({ count: 2, secret: "transfer-retained" });
    await tool(bob, "artifact_link", { kind: "script", name: script, slug: script, access: "public" });
    expect((await fetch(`${origin}/${script}`)).status).toBe(200);
    expect((await move(bobContext, "script", script, "private", "team")).status()).toBe(200);
    expect((await fetch(`${origin}/${script}`)).status).toBe(200);
    const collision = "ownership-collision";
    for (const [client, slug, contents] of [[alice, "collision-personal", "export default { private"], [teamBob, "collision-team", "export default { team"]] as const) {
      expect((await client.callTool({ name: "script_write", arguments: { name: collision, slug, contents } })).isError).toBe(true);
    }
    expect((await move(aliceContext, "script", collision, "private", "team")).status()).toBe(409);
    expect(payload(await tool(alice, "script_read", { name: collision })).source).toBe("export default { private");
    expect(payload(await tool(teamBob, "script_read", { name: collision })).source).toBe("export default { team");
    expect((await bobContext.request.post(`${origin}/api/library/move?workspace=test`, { headers: { Origin: "https://evil.example" }, data: { kind: "script", name: script, library: "team" } })).status()).toBe(403);
    expect((await bobContext.request.post(`${origin}/api/library/move?workspace=test`, { data: { kind: "script", name: script, library: "private", privateKey: "alice" } })).status()).toBe(400);
  } finally { await aliceContext.close(); await bobContext.close(); }
}, 180000);
