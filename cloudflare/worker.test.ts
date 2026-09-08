import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { ROUTING_CANVAS } from "../src/test/routing";

let runtime: Miniflare;
let runtimeOptions: ConstructorParameters<typeof Miniflare>[0];
let client: Client;
let origin: string;
const source = 'import { Button, H1, Stack, useCanvasState } from "sidequery/canvas";\nexport default function Canvas() { const [n, setN] = useCanvasState("n", 0); return <Stack><H1>Hosted canvas</H1><Button onClick={() => setN(n+1)}>Count {n}</Button></Stack>; }\n';
const counterClient = await readFile(new URL("../examples/counter.canvas.tsx", import.meta.url), "utf8");
const counterServer = await readFile(new URL("../examples/counter.canvas.server.ts", import.meta.url), "utf8");
const apiServer = `import { DurableObject } from "cloudflare:workers";
export class CanvasServer extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/headers") return Response.json(Object.fromEntries(request.headers));
    if (url.pathname === "/api/html") return new Response("<h1>API page</h1>", {headers:{"content-type":"text/html","set-cookie":"session=forged"}});
    if (url.pathname !== "/api" && url.pathname !== "/api/echo") return Response.json({error:"API route not found"}, {status:404});
    return new Response(request.method === "HEAD" ? null : await request.arrayBuffer(), {status:201, headers:{"content-type":"application/octet-stream","x-path":url.pathname + url.search,"x-method":request.method,"x-result":"api"}});
  }
}`;
let version: string;
beforeAll(async () => {
  const modulesRoot = join(import.meta.dir, "../dist/worker-app");
  const modules: Record<string, { type: "esm" | "wasm" | "text"; contents: string | Uint8Array<ArrayBuffer> }> = {};
  for (const name of await readdir(modulesRoot)) {
    if (name.endsWith(".js")) modules[name] = { type: "esm", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".html")) modules[name] = { type: "text", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
  }
  runtimeOptions = { cf: false, port: 0, workers: [{ config: {
    name: "canvas-app-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot, modules },
    env: {
      ENVIRONMENT: { type: "text", value: "local" },
      LIBRARIES: { type: "durable-object", worker: "canvas-app-test", exportName: "CanvasLibrary" },
      BACKENDS: { type: "durable-object", worker: "canvas-app-test", exportName: "CanvasBackend" },
      LINKS: { type: "durable-object", worker: "canvas-app-test", exportName: "ArtifactLinks" },
      SCRIPTS: { type: "durable-object", worker: "canvas-app-test", exportName: "ScriptLibrary" },
      SCRIPT_BACKENDS: { type: "durable-object", worker: "canvas-app-test", exportName: "ScriptBackend" },
      FILE_BACKENDS: { type: "durable-object", worker: "canvas-app-test", exportName: "CanvasFiles" },
      FILES: { type: "r2", name: "canvas-test-files" },
      LOADER: { type: "worker-loader" },
      ASSETS: { type: "assets" },
    },
    exports: { CanvasFiles: { type: "durable-object", storage: "sqlite" }, ArtifactLinks: { type: "durable-object", storage: "sqlite" }, ScriptLibrary: { type: "durable-object", storage: "sqlite" }, ScriptBackend: { type: "durable-object", storage: "sqlite" }, CanvasLibrary: { type: "durable-object", storage: "sqlite" }, CanvasBackend: { type: "durable-object", storage: "sqlite" } },
    assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" },
  }, dev: {} }] };
  runtime = new Miniflare(runtimeOptions);
  origin = (await runtime.ready).origin;
  client = new Client({ name: "canvas-integration", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=test`)));
}, 30000);
afterAll(async () => { await client?.close(); await runtime?.dispose(); });

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

test("official HTTP MCP client lists contracts, writes, edits, restores and retrieves raw history", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools.some(tool => tool.name === "canvas_write")).toBe(true);
  expect(tools.some(tool => tool.name === "canvas_guide")).toBe(true);
  const guide = await client.callTool({ name: "canvas_guide", arguments: {} });
  expect(guide.isError).not.toBe(true);
  const guideText = (guide.content as { text: string }[])[0]!.text;
  expect(guideText).toContain("sidequery/canvas");
  expect(tools.find(tool => tool.name === "script_guide")?.annotations?.readOnlyHint).toBe(true);
  const scriptGuide = await client.callTool({ name: "script_guide", arguments: {} });
  expect(scriptGuide.isError).not.toBe(true);
  expect((scriptGuide.content as { text: string }[])[0]!.text).toContain("Third-party dependencies");
  expect((tools.find(tool => tool.name === "canvas_open")!.inputSchema.properties!.target as { enum: string[] }).enum).toEqual(["inline"]);
  const result = await client.callTool({ name: "canvas_write", arguments: { name: "overview", contents: source } });
  expect(result.isError).not.toBe(true);
  expect(payload(result)).toMatchObject({ applied: true, ok: true });
  const canvas = (result._meta as { canvas: { js: string; versionId: string } }).canvas;
  expect(canvas.js).toContain("Hosted canvas");
  expect(JSON.stringify(result.content)).not.toContain("__herdrCanvasRuntime");
  version = canvas.versionId;
  const resource = await client.readResource({ uri: "ui://canvas/viewer.html" });
  expect(resource.contents[0]!.mimeType).toContain("text/html");
  expect(payload(await client.callTool({ name: "canvas_read", arguments: { name: "overview" } })).source).toBe(source);
  const failedEdit = await client.callTool({ name: "canvas_edit", arguments: { name: "overview", expected_hash: "0".repeat(64), edits: [{ old_text: "Hosted canvas", new_text: "Wrong" }] } });
  expect(failedEdit.isError).toBe(true);
  const edit = await client.callTool({ name: "canvas_edit", arguments: { name: "overview", edits: [{ old_text: "Hosted canvas", new_text: "Changed canvas" }] } });
  expect(payload(edit).ok).toBe(true);
  const restored = await client.callTool({ name: "canvas_restore", arguments: { version_id: version } });
  expect(payload(restored)).toMatchObject({ restored: true, ok: true });
  const historical = payload(await client.callTool({ name: "canvas_version", arguments: { version_id: version } }));
  expect(historical.source).toBe(source);
  expect(payload(await client.callTool({ name: "canvas_history", arguments: { name: "overview" } })).versions.length).toBeGreaterThanOrEqual(3);
  expect(payload(await client.callTool({ name: "canvas_history", arguments: { name: "overview", offset: 100 } }))).toMatchObject({ versions: [], next_offset: null });
  expect(payload(await client.callTool({ name: "canvas_list", arguments: { offset: 100 } }))).toMatchObject({ canvases: [], next_offset: null });
  expect(payload(await client.callTool({ name: "canvas_version", arguments: { version_id: version, events_offset: 100 } }))).toMatchObject({ events: [], events_offset: 100, next_events_offset: null });
  await expect(client.callTool({ name: "canvas_write", arguments: { name: "bad" } })).rejects.toThrow("Invalid tool arguments");
  await expect(client.callTool({ name: "canvas_open", arguments: { name: "overview", target: "herdr" } })).rejects.toThrow("Invalid tool arguments");
}, 60000);

test("plugin HTTP and MCP routes expose catalog hints and validate requests", async () => {
  const tools = (await client.listTools()).tools;
  for (const name of ["plugins_list", "plugin_guide"]) expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
  expect(tools.find(tool => tool.name === "canvas_plugin_call")?.annotations?.readOnlyHint).toBe(false);
  const list = await client.callTool({ name: "plugins_list", arguments: {} });
  expect(list.isError).not.toBe(true);
  expect(Array.isArray((list.structuredContent as { plugins: unknown[] }).plugins)).toBe(true);
  expect((await client.callTool({ name: "plugin_guide", arguments: {} })).isError).not.toBe(true);
  const call = { plugin: "missing-plugin-for-test", operation: "read", input: {} };
  const missing = await client.callTool({ name: "canvas_plugin_call", arguments: call });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing)).toContain("Plugin operation not found");
  await expect(client.callTool({ name: "canvas_plugin_call", arguments: { ...call, library: "team" } })).rejects.toThrow("Invalid tool arguments");
  for (const library of ["private", "team"]) {
    const response = await fetch(`${origin}/api/plugins/call?library=${library}`, { method: "POST", body: JSON.stringify(call) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Plugin operation not found" });
  }
  // Rejection probes can leave the request unread or cancel its stream. Keep
  // their closing sockets out of the pool used by the shared MCP client.
  for (const [status, body, requestOrigin] of [
    [400, "{}", undefined],
    [413, " ".repeat(256 * 1024 + 1), undefined],
    [403, JSON.stringify(call), "https://evil.example"],
  ] as const) {
    const response = await fetch(`${origin}/api/plugins/call`, {
      method: "POST", body, headers: { Connection: "close", ...(requestOrigin ? { Origin: requestOrigin } : {}) },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toBe("");
  }
  expect((await client.callTool({ name: "plugin_guide", arguments: {} })).isError).not.toBe(true);
});

test("invalid drafts remain readable with diagnostics and no preview", async () => {
  const result = await client.callTool({ name: "canvas_write", arguments: { name: "invalid", contents: 'const n: number = "bad"; export default function Canvas() { return <div>{n}</div>; }' } });
  expect(result.isError).toBe(true);
  expect(payload(result)).toMatchObject({ applied: true, ok: false });
  expect(result._meta).toBeUndefined();
  expect(payload(await client.callTool({ name: "canvas_read", arguments: { name: "invalid" } })).source).toContain('"bad"');
}, 30000);

test("native canvas SQLite works through MCP and the gallery, persists across code changes, and restores paired source", async () => {
  const written = await client.callTool({ name: "canvas_write", arguments: { name: "counter", contents: counterClient, server: counterServer } });
  expect(written.isError).not.toBe(true);
  const savedVersion = (written._meta as { canvas: { versionId: string; server: boolean } }).canvas;
  expect(savedVersion.server).toBe(true);
  expect(JSON.stringify(written.content)).not.toContain("create table");
  const callCounter = async (method = "GET", name = "counter") => {
    const result = await client.callTool({ name: "canvas_request", arguments: { name, request: { path: "/counter", method } } });
    expect(result.isError).not.toBe(true);
    const response = (result.structuredContent as { response: { status: number; body: string } }).response;
    expect(response.status).toBe(200);
    return JSON.parse(atob(response.body));
  };
  expect((await callCounter()).value).toBe(0);
  expect((await callCounter("POST")).value).toBe(1);
  expect((await callCounter("POST")).lastUpdated).toBeString();
  await client.callTool({ name: "canvas_write", arguments: { name: "other-counter", contents: counterClient, server: counterServer } });
  expect((await callCounter("GET", "other-counter")).value).toBe(0);
  const otherWorkspace = new Client({ name: "other-workspace", version: "1" });
  try {
    await otherWorkspace.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=other`)));
    expect((await otherWorkspace.callTool({ name: "canvas_write", arguments: { name: "counter", contents: counterClient, server: counterServer } })).isError).not.toBe(true);
    const isolated = await otherWorkspace.callTool({ name: "canvas_request", arguments: { name: "counter", request: { path: "/counter" } } });
    expect(isolated.isError).not.toBe(true);
    expect(JSON.parse(atob((isolated.structuredContent as { response: { body: string } }).response.body)).value).toBe(0);
  } finally { await otherWorkspace.close(); }
  const edited = await client.callTool({ name: "canvas_edit", arguments: { name: "counter", part: "server", edits: [{ old_text: "value: row.value", new_text: "value: row.value, generation: 2" }] } });
  expect(edited.isError).not.toBe(true);
  expect(await callCounter()).toMatchObject({ value: 2, generation: 2 });
  const restored = await client.callTool({ name: "canvas_restore", arguments: { version_id: savedVersion.versionId } });
  expect(restored.isError).not.toBe(true);
  expect(await callCounter()).toMatchObject({ value: 2 });
  expect((await callCounter()).generation).toBeUndefined();
  const serverRead = payload(await client.callTool({ name: "canvas_read", arguments: { name: "counter", part: "server", start_line: 1, end_line: 1 } }));
  expect(serverRead.source).toBe('import { DurableObject } from "cloudflare:workers";\n');
  expect(serverRead.server_source).toBeUndefined();
  const mismatch = await client.callTool({ name: "canvas_request", arguments: { name: "other-counter", version_id: savedVersion.versionId, request: { path: "/counter" } } });
  expect(mismatch.isError).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/?workspace=test`);
    await page.getByRole("button", { name: "counter", exact: true }).click();
    const frame = page.frameLocator("iframe");
    await frame.getByText("Count: 2", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Increment" }).click();
    await frame.getByText("Count: 3", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "counter", exact: true }).click();
    await page.frameLocator("iframe").getByText("Count: 3", { exact: true }).waitFor();
  } finally { await browser.close(); }
}, 60000);

test("gallery renders interactive sandboxed previews and serves exact archived source", async () => {
  const response = await fetch(`${origin}/api/source?workspace=test&version=${version}&download=1`);
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(await response.text()).toBe(source);
  const preview = await fetch(`${origin}/gallery/preview?workspace=test&version=${version}`);
  expect(preview.status).toBe(200);
  expect(preview.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const pages: number[] = [];
    // Exercise the gallery's pagination consumer with actual stored artifacts.
    await page.route("**/api/gallery?*", async route => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
      pages.push(offset);
      const data = await (await fetch(`${origin}/api/gallery?workspace=test`)).json() as { artifacts: unknown[] };
      await route.fulfill({ json: { ...data, artifacts: offset ? data.artifacts.slice(1) : data.artifacts.slice(0, 1), nextOffset: offset ? null : 100 } });
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?workspace=test`);
    await page.getByRole("button", { name: "overview", exact: true }).click();
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Hosted canvas" }).waitFor();
    await frame.getByRole("button", { name: "Count 0" }).click();
    await frame.getByRole("button", { name: "Count 1" }).waitFor();
    expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
    expect(errors).toEqual([]);
    expect(pages).toEqual([0, 100]);
  } finally { await browser.close(); }
}, 60000);

test("all hosted surfaces fail closed off loopback, and mutations enforce origin and request bounds", async () => {
  expect((await fetch(`${origin}/api/gallery`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${origin}/api/canvas/request`, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  expect((await fetch(`${origin}/api/canvas/request`, { method: "POST", body: "{}" })).status).toBe(400);
  expect((await fetch(`${origin}/api/canvas/request`, { method: "POST", body: " ".repeat(1024 * 1024 + 1) })).status).toBe(413);
  expect((await fetch(`${origin}/mcp`, { method: "POST", body: "invalid" })).status).toBe(400);
  expect((await fetch(`${origin}/mcp`, { method: "POST", body: " ".repeat(1024 * 1024 + 1) })).status).toBe(413);
  expect((await fetch(`${origin}/api/source?workspace=other&version=${version}`)).status).toBe(404);
  const production = new Miniflare({ cf: false, port: 0, workers: [{ ...runtimeOptions.workers![0]!, config: { ...runtimeOptions.workers![0]!.config, env: { ...runtimeOptions.workers![0]!.config.env, ENVIRONMENT: { type: "text", value: "production" } } } }] });
  try {
  for (const path of ["/", "/index.html", "/gallery.js", "/mcp", "/api/gallery", "/api/source", "/gallery/preview", "/api/canvas/request", "/api/plugins/call"]) {
    expect((await production.dispatchFetch(`https://canvas.example${path}`)).status).toBe(503);
  }
  } finally { await production.dispose(); }
});

test("verified users have isolated private libraries and can collaborate in the team library", async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { Response: RuntimeResponse } = await import("miniflare");
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" }] };
  const issuer = "https://canvas-test.cloudflareaccess.com";
  const sign = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setSubject(sub).setIssuer(issuer).setAudience("canvas-app").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
  const aliceToken = await sign("alice");
  const bobToken = await sign("bob");
  const production = new Miniflare({ cf: false, port: 0, workers: [{
    ...runtimeOptions.workers![0]!, config: {
      ...runtimeOptions.workers![0]!.config,
      env: { ...runtimeOptions.workers![0]!.config.env,
        ENVIRONMENT: { type: "text", value: "production" },
        ACCESS_TEAM_DOMAIN: { type: "text", value: "canvas-test.cloudflareaccess.com" },
        ACCESS_AUD: { type: "text", value: "canvas-app" },
      },
    },
    dev: { outboundService: { type: "fetcher", handler: request => {
      expect(request.url).toBe(`${issuer}/cdn-cgi/access/certs`);
      return RuntimeResponse.json(jwks);
    } } },
  }] });
  const clients: Client[] = [];
  try {
    const address = (await production.ready).origin;
    const connect = async (token: string, library: string) => {
      const remote = new Client({ name: "tenancy-test", version: "1" });
      clients.push(remote);
      await remote.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp?workspace=test&library=${library}`), {
        requestInit: { headers: { "Cf-Access-Jwt-Assertion": token } },
      }));
      return remote;
    };
    const alice = await connect(aliceToken, "private");
    const bob = await connect(bobToken, "private");
    const teamAlice = await connect(aliceToken, "team");
    const teamBob = await connect(bobToken, "team");
    expect((await alice.callTool({ name: "canvas_write", arguments: { name: "private-api", slug: "private-api", contents: source, server: apiServer } })).isError).not.toBe(true);
    expect((await fetch(`${address}/private-api/api/headers`)).status).toBe(401);
    expect((await fetch(`${address}/private-api/api/headers`, { headers: { "Cf-Access-Jwt-Assertion": bobToken } })).status).toBe(404);
    expect((await fetch(`${address}/private-api/api/headers`, { headers: { "Cf-Access-Jwt-Assertion": aliceToken, Origin: "https://evil.example" } })).status).toBe(403);
    const privateApi = await fetch(`${address}/private-api/api/headers`, { headers: { "Cf-Access-Jwt-Assertion": aliceToken, Authorization: "Bearer private-management", Cookie: "session=private", "Cf-Access-Client-Id": "id", "Cf-Access-Client-Secret": "secret", "x-kept": "yes" } });
    expect(privateApi.status).toBe(200);
    const privateHeaders = await privateApi.json() as Record<string, string>;
    expect(privateHeaders["x-kept"]).toBe("yes");
    for (const name of ["authorization", "cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) expect(privateHeaders[name]).toBeUndefined();
    const privateResult = await alice.callTool({ name: "canvas_write", arguments: { name: "secret", contents: source } });
    expect(privateResult.isError).not.toBe(true);
    const privateVersion = (privateResult._meta as { canvas: { versionId: string } }).canvas.versionId;
    expect(payload(await bob.callTool({ name: "canvas_list", arguments: {} })).canvases).toEqual([]);
    for (const other of [bob, teamAlice, teamBob]) {
      expect((await other.callTool({ name: "canvas_read", arguments: { name: "secret" } })).isError).toBe(true);
      expect((await other.callTool({ name: "canvas_version", arguments: { version_id: privateVersion } })).isError).toBe(true);
      expect((await other.callTool({ name: "canvas_restore", arguments: { version_id: privateVersion } })).isError).toBe(true);
    }
    const shared = await teamAlice.callTool({ name: "canvas_write", arguments: { name: "shared", contents: source } });
    expect(shared.isError).not.toBe(true);
    expect(payload(await teamBob.callTool({ name: "canvas_read", arguments: { name: "shared" } })).source).toBe(source);
    expect((await teamBob.callTool({ name: "canvas_edit", arguments: { name: "shared", edits: [{ old_text: "Hosted canvas", new_text: "Team canvas" }] } })).isError).not.toBe(true);
    expect(payload(await teamAlice.callTool({ name: "canvas_read", arguments: { name: "shared" } })).source).toContain("Team canvas");
    expect((await alice.callTool({ name: "canvas_read", arguments: { name: "shared" } })).isError).toBe(true);
    for (const path of [`/api/source?version=${privateVersion}`, `/gallery/preview?version=${privateVersion}`, `/api/source?name=secret&subject=alice`, `/api/source?library=team&version=${privateVersion}`]) {
      expect((await fetch(address + path + "&workspace=test", { headers: { "Cf-Access-Jwt-Assertion": bobToken } })).status).toBe(404);
    }
    expect((await fetch(`${address}/api/gallery?library=alice`, { headers: { "Cf-Access-Jwt-Assertion": bobToken } })).status).toBe(400);
    // The same canvas name must identify different databases across private
    // subjects, while both team members operate on one shared database.
    for (const remote of [alice, bob, teamAlice]) {
      expect((await remote.callTool({ name: "canvas_write", arguments: { name: "database", contents: counterClient, server: counterServer } })).isError).not.toBe(true);
    }
    const files = async (remote: Client, request: Record<string, unknown>) => {
      const result = await remote.callTool({ name: "canvas_files", arguments: { name: "database", request } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { result: any }).result;
    };
    const privateUpload = await files(alice, { operation: "upload", name: "private.txt", size: 3, type: "text/plain" });
    // The grant is sufficient for bytes; it never grants management access.
    expect((await fetch(privateUpload.url, { method: "PUT", body: "one" })).status).toBe(201);
    expect((await files(alice, { operation: "list" })).files).toHaveLength(1);
    expect((await files(bob, { operation: "list" })).files).toEqual([]);
    expect((await files(teamAlice, { operation: "list" })).files).toEqual([]);
    expect((await bob.callTool({ name: "canvas_files", arguments: { name: "database", request: { operation: "download", id: privateUpload.file.id } } })).isError).toBe(true);
    const teamUpload = await files(teamAlice, { operation: "upload", name: "team.txt", size: 3, type: "text/plain" });
    expect((await fetch(teamUpload.url, { method: "PUT", body: "two" })).status).toBe(201);
    expect((await files(teamBob, { operation: "list" })).files[0].id).toBe(teamUpload.file.id);
    const otherWorkspace = await fetch(`${address}/api/tools?workspace=other`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": aliceToken }, body: JSON.stringify({ name: "canvas_write", arguments: { name: "database", contents: source } }) });
    expect(otherWorkspace.status).toBe(200);
    const otherFiles = await fetch(`${address}/api/canvas/files?workspace=other`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": aliceToken }, body: JSON.stringify({ name: "database", request: { operation: "list" } }) });
    expect(await otherFiles.json()).toEqual({ result: { files: [] } });
    expect((await fetch(`${address}/api/canvas/files?workspace=test`, { method: "POST", body: JSON.stringify({ name: "database", request: { operation: "list" } }) })).status).toBe(401);
    const database = async (remote: Client, method = "GET") => {
      const result = await remote.callTool({ name: "canvas_request", arguments: { name: "database", request: { path: "/counter", method } } });
      expect(result.isError).not.toBe(true);
      const response = (result.structuredContent as { response: { status: number; body: string } }).response;
      expect(response.status).toBe(200);
      return JSON.parse(atob(response.body));
    };
    expect((await database(alice, "POST")).value).toBe(1);
    expect((await database(bob)).value).toBe(0);
    expect((await database(teamAlice)).value).toBe(0);
    expect((await database(teamAlice, "POST")).value).toBe(1);
    expect((await database(teamBob, "POST")).value).toBe(2);
    expect((await database(teamAlice)).value).toBe(2);
    expect((await database(alice)).value).toBe(1);
    expect((await database(bob)).value).toBe(0);
    expect((await bob.callTool({ name: "canvas_request", arguments: { version_id: privateVersion, request: { path: "/counter" } } })).isError).toBe(true);
    const script = 'export default {fetch(request: Request) { return Response.json({message:"owner script",authorization:request.headers.get("authorization")}); }}';
    expect((await alice.callTool({name:"script_write",arguments:{name:"private-handler",slug:"private-handler",contents:script}})).isError).not.toBe(true);
    expect((await fetch(address+"/private-handler")).status).toBe(401);
    expect((await fetch(address+"/private-handler",{headers:{"Cf-Access-Jwt-Assertion":bobToken}})).status).toBe(404);
    expect((await fetch(address+"/private-handler",{headers:{"Cf-Access-Jwt-Assertion":aliceToken}})).status).toBe(200);
    const invalidPublic = await alice.callTool({name:"script_write",arguments:{name:"private-handler",slug:"private-handler",access:"public",contents:"export default {fetch(}"}});
    expect(invalidPublic.isError).toBe(true);
    expect((await fetch(address+"/private-handler")).status).toBe(401);
    expect((await fetch(address+"/private-handler",{headers:{"Cf-Access-Jwt-Assertion":aliceToken}})).status).toBe(200);
    expect((await bob.callTool({name:"script_read",arguments:{name:"private-handler"}})).isError).toBe(true);
    expect((await bob.callTool({name:"script_write",arguments:{name:"private-handler",slug:"private-handler",contents:script}})).isError).toBe(true);
    expect((await alice.callTool({name:"artifact_link",arguments:{kind:"script",name:"private-handler",slug:"private-handler",access:"public"}})).isError).not.toBe(true);
    const external=await fetch(address+"/private-handler",{method:"POST",headers:{Origin:"https://sender.example",Authorization:"Bearer webhook-token"}});
    expect(external.status).toBe(200);
    expect(await external.json()).toMatchObject({authorization:"Bearer webhook-token"});
    expect((await fetch(address+"/api/gallery")).status).toBe(401);
    expect((await alice.callTool({name:"artifact_link",arguments:{kind:"canvas",name:"secret",slug:"private-canvas"}})).isError).not.toBe(true);
    expect((await fetch(address+"/private-canvas")).status).toBe(401);
    expect((await fetch(address+"/private-canvas",{headers:{"Cf-Access-Jwt-Assertion":bobToken}})).status).toBe(404);
    expect((await fetch(address+"/private-canvas",{headers:{"Cf-Access-Jwt-Assertion":aliceToken}})).status).toBe(200);
    const pluginBody = JSON.stringify({ plugin: "missing-plugin-for-test", operation: "read", input: {} });
    expect((await fetch(address+"/private-canvas/_canvas/plugins",{method:"POST",body:pluginBody})).status).toBe(401);
    expect((await fetch(address+"/private-canvas/_canvas/plugins",{method:"POST",headers:{"Cf-Access-Jwt-Assertion":bobToken},body:pluginBody})).status).toBe(404);
    const privatePlugin = await fetch(address+"/private-canvas/_canvas/plugins",{method:"POST",headers:{"Cf-Access-Jwt-Assertion":aliceToken},body:pluginBody});
    expect(privatePlugin.status).toBe(404);
    expect(await privatePlugin.json()).toEqual({error:"Plugin operation not found"});
    expect((await alice.callTool({name:"canvas_write",arguments:{name:"secret",slug:"private-canvas",access:"public",contents:"export default function {"}})).isError).toBe(true);
    expect((await fetch(address+"/private-canvas")).status).toBe(401);
    expect((await alice.callTool({name:"artifact_link",arguments:{kind:"canvas",name:"secret",slug:"private-canvas",access:"public"}})).isError).not.toBe(true);
    expect((await fetch(address+"/private-canvas")).status).toBe(200);
    for (const headers of [{}, {"Cf-Access-Jwt-Assertion":aliceToken}, {Cookie:"session=ambient"}]) {
      expect((await fetch(address+"/private-canvas/_canvas/plugins",{method:"POST",headers,body:pluginBody})).status).toBe(401);
    }
    expect((await alice.callTool({name:"artifact_link",arguments:{kind:"canvas",name:"secret",slug:"private-canvas",access:"private"}})).isError).not.toBe(true);
    expect((await fetch(address+"/private-canvas")).status).toBe(401);
    // Restore a valid draft for the existing gallery assertion below.
    expect((await alice.callTool({name:"canvas_write",arguments:{name:"secret",contents:source}})).isError).not.toBe(true);
    expect((await teamAlice.callTool({name:"script_write",arguments:{name:"shared-handler",slug:"shared-handler",contents:script}})).isError).not.toBe(true);
    expect((await fetch(address+"/shared-handler",{headers:{"Cf-Access-Jwt-Assertion":bobToken}})).status).toBe(200);
    expect((await alice.callTool({name:"script_write",arguments:{name:"untrusted-page",slug:"untrusted-page",access:"public",contents:"export default {fetch(){return new Response(\"<!doctype html><div id=\\\"result\\\">pending</div><script>\\n(async()=>{let cookieBlocked=false;try{document.cookie}catch{cookieBlocked=true}let storageBlocked=false;try{localStorage.getItem('session')}catch{storageBlocked=true}let requestBlocked=false;try{const r=await fetch('/api/gallery',{credentials:'include'});requestBlocked=r.status===403}catch{requestBlocked=true}document.querySelector('#result').textContent=JSON.stringify({cookieBlocked,storageBlocked,requestBlocked});})();\\n</script>\",{headers:{\"content-type\":\"text/html\"}})}}"}})).isError).not.toBe(true);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": aliceToken } });
      await page.goto(`${address}/?workspace=test`);
      await page.getByRole("button", { name: "secret", exact: true }).waitFor();
      expect(await page.getByLabel("Library", { exact: true }).inputValue()).toBe("private");
      await page.getByLabel("Library", { exact: true }).selectOption("team");
      await page.getByRole("button", { name: "shared", exact: true }).click();
      await page.frameLocator("iframe").getByRole("heading", { name: "Team canvas" }).waitFor();
      expect(await page.getByRole("button", { name: "secret", exact: true }).count()).toBe(0);
      expect(new URL(page.url()).searchParams.get("library")).toBe("team");
      const isolated = await browser.newPage({extraHTTPHeaders:{"Cf-Access-Jwt-Assertion":aliceToken}});
      await isolated.goto(address+"/untrusted-page");
      await isolated.waitForFunction(()=>document.querySelector('#result')?.textContent!=="pending");
      expect(JSON.parse(await isolated.locator('#result').innerText())).toEqual({cookieBlocked:true,storageBlocked:true,requestBlocked:true});
    } finally { await browser.close(); }
  } finally {
    await Promise.all(clients.map(remote => remote.close()));
    await production.dispose();
  }
}, 120000);

test("standalone scripts serve arbitrary HTTP responses at chosen root slugs and retain last valid code", async () => {
  const code = `export default { async fetch(request: Request, env: ScriptEnv) {
    env.sql.exec("create table if not exists hits(value integer)");
    env.sql.exec("insert into hits values (1)");
    console.log("handled", env.secrets.TOKEN ?? "unset");
    if (new URL(request.url).pathname.endsWith("/html")) return new Response("<h1>Script page</h1>", {headers:{"content-type":"text/html", "set-cookie":"danger=yes"}});
    return Response.json({url:request.url,method:request.method,header:request.headers.get("x-example"),body:await request.text(),count:env.sql.exec("select count(*) as n from hits").one().n,secret:env.secrets.TOKEN??null,cookie:request.headers.get("cookie"),assertion:request.headers.get("cf-access-jwt-assertion"),serviceSecret:request.headers.get("cf-access-client-secret"),serviceId:request.headers.get("cf-access-client-id")}, {status:201,headers:{"x-result":"script"}});
  }};`;
  const saved = await client.callTool({ name: "script_write", arguments: { name: "http-script", slug: "my-handler", access: "public", contents: code } });
  expect(saved.isError).not.toBe(true);
  expect(payload(saved)).toMatchObject({ url: `${origin}/my-handler`, slug: "my-handler", ok: true });
  await client.callTool({ name: "script_secrets", arguments: { name: "http-script", secrets: { TOKEN: "fixture-sensitive-value" } } });
  const response = await fetch(`${origin}/my-handler/extra?param=value`, { method: "POST", headers: { "x-example": "kept", Origin: "https://external.example", Cookie: "session=management", "Cf-Access-Jwt-Assertion": "private-assertion", "Cf-Access-Client-Secret": "management-service-secret", "Cf-Access-Client-Id": "management-service-id" }, body: ' { "hello": "世界" }\n' });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-result")).toBe("script");
  expect(await response.json()).toMatchObject({ url: `${origin}/my-handler/extra?param=value`, method: "POST", header: "kept", body: ' { "hello": "世界" }\n', count: 1, secret: "fixture-sensitive-value", cookie: null, assertion: null, serviceSecret: null, serviceId: null });
  const logs = await client.callTool({ name: "script_logs", arguments: { name: "http-script" } });
  expect(JSON.stringify(logs)).not.toContain("fixture-sensitive-value");
  expect(JSON.stringify(logs)).toContain("REDACTED");
  const sourceRead = await client.callTool({ name: "script_read", arguments: { name: "http-script" } });
  expect(payload(sourceRead).source).toBe(code);
  const history = payload(await client.callTool({ name: "script_history", arguments: { name: "http-script" } }));
  expect(JSON.stringify(history)).not.toContain("fixture-sensitive-value");
  const updated = await client.callTool({ name: "script_edit", arguments: { name: "http-script", edits: [{ old_text: '"x-result":"script"', new_text: '"x-result":"updated"' }] } });
  expect(updated.isError).not.toBe(true);
  const updatedResponse = await fetch(`${origin}/my-handler`);
  expect(updatedResponse.headers.get("x-result")).toBe("updated");
  expect((await updatedResponse.json() as { count: number }).count).toBe(2);
  const invalid = await client.callTool({ name: "script_write", arguments: { name: "http-script", contents: "export default { fetch( }" } });
  expect(invalid.isError).toBe(true);
  expect(payload(invalid)).toMatchObject({ applied: true, ok: false, slug: "my-handler" });
  expect((await fetch(`${origin}/my-handler`)).headers.get("x-result")).toBe("updated");
  const badModule = await client.callTool({name:"script_write",arguments:{name:"http-script",contents:'throw new Error("module failed"); export default {fetch() {return new Response("bad");}};'}});
  expect(badModule.isError).toBe(true);
  expect(payload(badModule)).toMatchObject({applied:true,ok:false});
  expect((await fetch(`${origin}/my-handler`)).headers.get("x-result")).toBe("updated");
  const restored = await client.callTool({ name: "script_restore", arguments: { name: "http-script", version_id: history.versions[0].id } });
  expect(restored.isError).not.toBe(true);
  expect((await fetch(`${origin}/my-handler`)).headers.get("x-result")).toBe("script");
  const duplicate = await client.callTool({ name: "script_write", arguments: { name: "different", slug: "my-handler", contents: code } });
  expect(duplicate.isError).toBe(true);
  expect((await client.callTool({ name: "script_read", arguments: { name: "different" } })).isError).toBe(true);
  expect((await client.callTool({ name: "script_write", arguments: { name: "reserved", slug: "api", contents: code } })).isError).toBe(true);
  const page = await fetch(`${origin}/my-handler/html`);
  expect(await page.text()).toBe("<h1>Script page</h1>");
  expect(page.headers.get("set-cookie")).toBeNull();
  expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms");
  const run = await client.callTool({ name: "script_run", arguments: { name: "http-script", request: { path: "/manual", method: "PATCH", body: btoa("manual body") } } });
  expect(run.isError).not.toBe(true);
  const runBody = JSON.parse(atob((run.structuredContent as {response:{body:string}}).response.body));
  expect(runBody).toMatchObject({method:"PATCH",body:"manual body"});
  const gallery = await (await fetch(`${origin}/api/gallery?workspace=test`)).json() as {artifacts:{name:string;kind?:string;url?:string}[]};
  expect(gallery.artifacts.find(item=>item.name==="http-script")).toMatchObject({kind:"script",url:`${origin}/my-handler`});
  const source = await fetch(`${origin}/api/source?workspace=test&kind=script&name=http-script`);
  expect(await source.text()).toBe(code);
}, 60000);

test("root canvas URLs render interactive backends and keep valid revisions through broken drafts", async () => {
  const saved = await client.callTool({ name: "canvas_write", arguments: { name: "linked-counter", slug: "my-counter", access: "public", contents: counterClient, server: counterServer } });
  expect(saved.isError).not.toBe(true);
  expect(payload(saved).url).toBe(`${origin}/my-counter`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/my-counter`);
    await page.frameLocator("iframe").getByText("Count: 0", {exact:true}).waitFor();
    await page.frameLocator("iframe").getByRole("button", {name:"Increment"}).click();
    await page.frameLocator("iframe").getByText("Count: 1", {exact:true}).waitFor();
    const invalid = await client.callTool({ name: "canvas_write", arguments: { name: "linked-counter", contents: "export default function {" } });
    expect(invalid.isError).toBe(true);
    await page.reload();
    await page.frameLocator("iframe").getByText("Count: 1", {exact:true}).waitFor();
    const fixed = await client.callTool({ name: "canvas_write", arguments: { name: "linked-counter", contents: counterClient.replace("Count:", "Total:") } });
    expect(fixed.isError).not.toBe(true);
    await page.reload();
    await page.frameLocator("iframe").getByText("Total: 1", {exact:true}).waitFor();
    const stolen = await client.callTool({ name: "artifact_link", arguments: { kind:"canvas",name:"linked-counter",slug:"my-handler" } });
    expect(stolen.isError).toBe(true);
  } finally { await browser.close(); }
  const version = (saved._meta as {canvas:{versionId:string}}).canvas.versionId;
  const mismatch=await fetch(`${origin}/my-counter/_canvas/request`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({version_id:version,request:{path:"/counter"}})});
  expect(mismatch.status).toBe(409);
  expect((await fetch(`${origin}/my-counter/_canvas/request`,{method:"POST",headers:{Origin:"https://evil.example"},body:"{}"})).status).toBe(403);
},60000);

test("correcting initial invalid drafts retains the user-chosen slug and access", async () => {
  const invalid = 'export default { fetch( }';
  const saved = await client.callTool({name:"script_write",arguments:{name:"Human name",slug:"chosen-human",access:"public",contents:invalid}});
  expect(saved.isError).toBe(true);
  expect(payload(saved)).toMatchObject({slug:"chosen-human",access:"public",applied:true,ok:false});
  expect(payload(saved).url).toBeUndefined();
  const fixed = await client.callTool({name:"script_edit",arguments:{name:"Human name",edits:[{old_text:invalid,new_text:'export default {fetch(){return new Response("corrected");}}'}]}});
  expect(fixed.isError).not.toBe(true);
  expect(payload(fixed).url).toBe(`${origin}/chosen-human`);
  expect(await (await fetch(`${origin}/chosen-human`)).text()).toBe("corrected");
  const badCanvas='export default function {';
  const canvas = await client.callTool({name:"canvas_write",arguments:{name:"Human canvas",slug:"chosen-canvas",access:"public",contents:badCanvas}});
  expect(canvas.isError).toBe(true);
  expect(payload(canvas)).toMatchObject({slug:"chosen-canvas",access:"public"});
  const corrected=await client.callTool({name:"canvas_edit",arguments:{name:"Human canvas",edits:[{old_text:badCanvas,new_text:source}]}});
  expect(corrected.isError).not.toBe(true);
  expect(payload(corrected).url).toBe(`${origin}/chosen-canvas`);
  expect((await fetch(`${origin}/chosen-canvas`)).status).toBe(200);
});

test("standalone canvas APIs preserve HTTP semantics and never fall back to the page shell", async () => {
  const saved = await client.callTool({ name: "canvas_write", arguments: { name: "direct-api", slug: "direct-api", access: "public", contents: source, server: apiServer } });
  expect(saved.isError).not.toBe(true);
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 42]);
  for (const path of ["/api", "/api/echo?value=%FF&value=two"]) {
    const response = await fetch(`${origin}/direct-api${path}`, { method: "PATCH", body: bytes });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-path")).toBe(path);
    expect(response.headers.get("x-method")).toBe("PATCH");
    expect(response.headers.get("x-result")).toBe("api");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }
  const headers = await (await fetch(`${origin}/direct-api/api/headers`, { headers: { Cookie: "session=ambient", "Cf-Access-Jwt-Assertion": "ambient", "Cf-Access-Client-Id": "id", "Cf-Access-Client-Secret": "secret", Authorization: "Bearer application" } })).json() as Record<string, string>;
  expect(headers.authorization).toBe("Bearer application");
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) expect(headers[name]).toBeUndefined();
  for (const method of ["GET", "POST"]) expect((await fetch(`${origin}/direct-api/api`, { method, headers: { Origin: "https://evil.example", Cookie: "session=ambient" } })).status).toBe(403);
  expect((await fetch(`${origin}/direct-api/api`, { method: "POST", body: new Uint8Array(256 * 1024 + 1) })).status).toBe(413);
  const missing = await fetch(`${origin}/direct-api/api/missing`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "API route not found" });
  const head = await fetch(`${origin}/direct-api/api`, { method: "HEAD" });
  expect(head.status).toBe(201);
  expect(head.headers.get("x-method")).toBe("HEAD");
  expect(await head.text()).toBe("");
  const html = await fetch(`${origin}/direct-api/api/html`);
  expect(await html.text()).toBe("<h1>API page</h1>");
  expect(html.headers.get("set-cookie")).toBeNull();
  expect(html.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
  expect((await client.callTool({ name: "canvas_write", arguments: { name: "direct-api", contents: source, server: "export class CanvasServer { fetch( }" } })).isError).toBe(true);
  expect((await fetch(`${origin}/direct-api/api`)).status).toBe(201);

  expect((await client.callTool({ name: "canvas_write", arguments: { name: "pages-only", slug: "pages-only", access: "public", contents: source } })).isError).not.toBe(true);
  const absent = await fetch(`${origin}/pages-only/api/missing`);
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "Canvas has no server" });
  const deep = await fetch(`${origin}/pages-only/projects/42?tab=detail`);
  expect(deep.status).toBe(200);
  expect(deep.headers.get("content-type")).toContain("text/html");
  expect(await deep.text()).toContain("/projects/42?tab=detail");
  const deepHead = await fetch(`${origin}/pages-only/projects/42`, { method: "HEAD" });
  expect(deepHead.status).toBe(200);
  expect(deepHead.headers.get("content-type")).toContain("text/html");
  expect(await deepHead.text()).toBe("");
  expect((await fetch(`${origin}/pages-only/projects/42`, { method: "POST" })).status).toBe(405);
  for (const path of ["/_canvas", "/_canvas/unknown", "/_canvas/request/extra", "/_canvas/plugins/extra"]) expect((await fetch(`${origin}/pages-only${path}`)).status).toBe(404);
}, 60000);

test("standalone nested canvas pages restore browser routes on direct load and refresh", async () => {
  expect((await client.callTool({ name: "canvas_write", arguments: { name: "linked-routes", slug: "linked-routes", access: "public", contents: ROUTING_CANVAS } })).isError).not.toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/linked-routes/accounts/123?tab=activity#latest`);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Account 123" }).waitFor();
    await frame.getByText("Tab: activity", { exact: true }).waitFor();
    await frame.getByText("Hash: #latest", { exact: true }).waitFor();
    await frame.getByRole("link", { name: "Next account" }).click();
    await page.waitForURL(`${origin}/linked-routes/accounts/456`);
    await page.reload();
    await frame.getByRole("heading", { name: "Account 456" }).waitFor();
    await page.goBack();
    await frame.getByRole("heading", { name: "Account 123" }).waitFor();
    await frame.getByText("Hash: #latest", { exact: true }).waitFor();
  } finally { await browser.close(); }
}, 60000);

test("canvas files use per-canvas storage through MCP and standalone controls", async () => {
  const write = async (name: string) => {
    const result = await client.callTool({ name: "canvas_write", arguments: { name, slug: name, contents: source } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return (result._meta as { canvas: { versionId: string; files: boolean } }).canvas;
  };
  const a = await write("files-a");
  const b = await write("files-b");
  expect(a.files).toBe(true);
  const request = async (version: string, value: Record<string, unknown>) => {
    const response = await client.callTool({ name: "canvas_files", arguments: { version_id: version, request: value } });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return (response.structuredContent as { result: any }).result;
  };
  const bytes = Buffer.alloc(2 * 1024 * 1024, 137);
  const grant = await request(a.versionId, { operation: "upload", name: "café.bin", size: bytes.length, type: "application/octet-stream" });
  expect((await fetch(grant.url, { method: "PUT", body: bytes })).status).toBe(201);
  expect((await request(a.versionId, { operation: "list" })).files).toHaveLength(1);
  expect((await request(b.versionId, { operation: "list" })).files).toEqual([]);
  const download = await request(a.versionId, { operation: "download", id: grant.file.id });
  expect(Buffer.from(await (await fetch(download.url)).arrayBuffer())).toEqual(bytes);
  const wrongCanvas = await client.callTool({ name: "canvas_files", arguments: { name: "files-b", version_id: a.versionId, request: { operation: "list" } } });
  expect(wrongCanvas.isError).toBe(true);
  const otherFile = await client.callTool({ name: "canvas_files", arguments: { version_id: b.versionId, request: { operation: "download", id: grant.file.id } } });
  expect(otherFile.isError).toBe(true);
  const renamed = await write("files-a");
  expect((await request(renamed.versionId, { operation: "list" })).files[0].id).toBe(grant.file.id);
  expect((await client.callTool({ name: "artifact_link", arguments: { kind: "canvas", name: "files-a", slug: "files-public", access: "public" } })).isError).not.toBe(true);
  const publicRequest = (value: Record<string, unknown>, version_id = renamed.versionId) => fetch(`${origin}/files-public/_canvas/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version_id, request: value }) });
  expect((await publicRequest({ operation: "list" })).status).toBe(200);
  expect((await publicRequest({ operation: "download", id: grant.file.id })).status).toBe(200);
  expect((await publicRequest({ operation: "upload", name: "bad", size: 1, type: "text/plain" })).status).toBe(403);
  expect((await publicRequest({ operation: "delete", id: grant.file.id })).status).toBe(403);
  expect((await publicRequest({ operation: "list" }, b.versionId)).status).toBe(409);
  const forged = await fetch(`${origin}/api/canvas/files?workspace=test`, { method: "POST", headers: { Origin: "null" }, body: JSON.stringify({ name: "files-a", request: { operation: "list" } }) });
  expect(forged.status).toBe(403);
  const resource = await client.readResource({ uri: "ui://canvas/viewer.html" });
  expect(JSON.stringify(resource)).toContain(`\"connectDomains\":[\"${origin}\"]`);
}, 60_000);

test("gallery and standalone file uploads and downloads work outside the sandboxed frame", async () => {
  const contents = await Bun.file(new URL("../examples/files.canvas.tsx", import.meta.url)).text();
  const created = await client.callTool({ name: "canvas_write", arguments: { name: "browser-files", slug: "browser-files", contents } });
  expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/browser-files`);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Canvas files" }).waitFor();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 193);
    await frame.getByLabel("Upload file").setInputFiles({ name: "browser.bin", mimeType: "application/octet-stream", buffer: bytes });
    const downloadButton = frame.getByRole("button", { name: "Download browser.bin", exact: true });
    await downloadButton.waitFor({ timeout: 30_000 });
    const pending = page.waitForEvent("download");
    await downloadButton.click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("browser.bin");
    expect(await download.failure()).toBeNull();
    expect(Buffer.from(await Bun.file((await download.path())!).arrayBuffer())).toEqual(bytes);
    // The same file is available through the gallery's independently scoped bridge.
    await page.goto(`${origin}/gallery?workspace=test`);
    await page.getByRole("button", { name: "browser-files", exact: true }).click();
    const galleryFrame = page.frameLocator("iframe.preview-frame");
    const galleryDownload = galleryFrame.getByRole("button", { name: "Download browser.bin", exact: true });
    await galleryDownload.waitFor({ timeout: 30_000 });
    const next = page.waitForEvent("download");
    await galleryDownload.click();
    expect(await (await next).failure()).toBeNull();
    await galleryFrame.getByRole("button", { name: "Delete browser.bin", exact: true }).click();
    await galleryDownload.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    await page.close();
  } finally { await browser.close(); }
}, 90_000);
test("hosted remix tools create private independent artifacts and reject overwrites", async () => {
  const original = payload(await client.callTool({name:"canvas_write",arguments:{name:"remix-original",contents:counterClient,server:counterServer,slug:"remix-original",access:"public"}}));
  expect(original.ok).toBe(true);
  const copied = payload(await client.callTool({name:"canvas_remix",arguments:{name:"remix-original",new_name:"remix-copy"}}));
  expect(copied).toMatchObject({ok:true,remixed:true,name:"remix-copy",access:"private",slug:"remix-copy"});
  expect(copied.origin.source_version_id).toBeString();
  expect((await client.callTool({name:"canvas_remix",arguments:{name:"remix-original",new_name:"remix-copy"}})).isError).toBe(true);
  const script='export default {fetch(request: Request,env: ScriptEnv) { env.sql.exec("create table if not exists counter(n integer)"); env.sql.exec("insert into counter values (1)"); return Response.json({count:env.sql.exec("select count(*) as n from counter").one().n,secret:env.secrets.TOKEN ?? null}); }}';
  expect(payload(await client.callTool({name:"script_write",arguments:{name:"remix-script",contents:script,access:"public"}})).ok).toBe(true);
  await client.callTool({name:"script_secrets",arguments:{name:"remix-script",secrets:{TOKEN:"original-only"}}});
  const run=async(name:string)=>{
    const result=await client.callTool({name:"script_run",arguments:{name,request:{path:"/"}}});
    const envelope=(result.structuredContent as any).response;
    return JSON.parse(Buffer.from(envelope.body,"base64").toString());
  };
  expect(await run("remix-script")).toEqual({count:1,secret:"original-only"});
  expect(payload(await client.callTool({name:"script_remix",arguments:{name:"remix-script",new_name:"remix-script-copy"}}))).toMatchObject({ok:true,remixed:true,access:"private"});
  expect(await run("remix-script-copy")).toEqual({count:1,secret:null});
  expect(await run("remix-script")).toEqual({count:2,secret:"original-only"});
  expect((await client.callTool({name:"script_remix",arguments:{name:"remix-script",new_name:"remix-script-copy"}})).isError).toBe(true);
}, 120000);

test("canvas schedules retain validated revisions, keep host history isolated, and pause on server removal", async () => {
  const name = "scheduled-counter";
  const write = await client.callTool({ name: "canvas_write", arguments: { name, contents: counterClient, server: counterServer } });
  expect(write.isError).not.toBe(true);
  const version = (write._meta as { canvas: { versionId: string } }).canvas.versionId;
  const tool = async (nameOfTool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: nameOfTool, arguments: { name, ...args } });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as any;
  };
  const saved = await tool("canvas_schedule", { action: "set", interval_seconds: 3600, request: { path: "/counter", method: "POST" } });
  expect(saved.schedule).toMatchObject({ paused: false, interval_seconds: 3600 });
  await tool("canvas_schedule", { action: "pause" });
  const invalid = await client.callTool({ name: "canvas_write", arguments: { name, contents: "export default function {" } });
  expect(invalid.isError).toBe(true);
  await tool("canvas_schedule", { action: "run_now" });
  const response = await tool("canvas_request", { version_id: version, request: { path: "/counter" } });
  expect(JSON.parse(atob(response.response.body)).value).toBe(1);
  const runs = (await tool("canvas_runs")).runs;
  expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ revision: version, trigger: "manual", status: "succeeded", http_status: 200 })]));
  // A canvas's own SQL database cannot inspect supervisor execution history.
  const inspectServer = `import { DurableObject } from "cloudflare:workers";
export class CanvasServer extends DurableObject { fetch() { return Response.json(this.ctx.storage.sql.exec("select name from sqlite_master where name='execution_runs'").toArray()); } }`;
  expect((await client.callTool({ name: "canvas_write", arguments: { name, contents: counterClient, server: inspectServer } })).isError).not.toBe(true);
  const inspected = await tool("canvas_request", { request: { path: "/" } });
  expect(JSON.parse(atob(inspected.response.body))).toEqual([]);
  expect((await client.callTool({ name: "canvas_write", arguments: { name, contents: counterClient, server: null } })).isError).not.toBe(true);
  expect((await tool("canvas_schedule")).schedule).toMatchObject({ paused: true, next_run_at: null });
  expect((await client.callTool({ name: "canvas_schedule", arguments: { name, action: "resume" } })).isError).toBe(true);
}, 120000);
