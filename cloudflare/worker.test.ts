import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";

let runtime: Miniflare;
let runtimeOptions: ConstructorParameters<typeof Miniflare>[0];
let client: Client;
let origin: string;
const source = 'import { Button, H1, Stack, useCanvasState } from "herdr/canvas";\nexport default function Canvas() { const [n, setN] = useCanvasState("n", 0); return <Stack><H1>Hosted canvas</H1><Button onClick={() => setN(n+1)}>Count {n}</Button></Stack>; }\n';
const counterClient = await readFile(new URL("../examples/counter.canvas.tsx", import.meta.url), "utf8");
const counterServer = await readFile(new URL("../examples/counter.canvas.server.ts", import.meta.url), "utf8");
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
      LOADER: { type: "worker-loader" },
      ASSETS: { type: "assets" },
    },
    exports: { CanvasLibrary: { type: "durable-object", storage: "sqlite" }, CanvasBackend: { type: "durable-object", storage: "sqlite" } },
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
  const example = guideText.match(/```tsx\n([\s\S]*?)```/)?.[1];
  expect(example).toBeDefined();
  expect(payload(await client.callTool({ name: "canvas_write", arguments: { name: "guide-counter", contents: example } })).ok).toBe(true);
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
  for (const path of ["/", "/index.html", "/gallery.js", "/mcp", "/api/gallery", "/api/source", "/gallery/preview", "/api/canvas/request"]) {
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
    } finally { await browser.close(); }
  } finally {
    await Promise.all(clients.map(remote => remote.close()));
    await production.dispose();
  }
}, 60000);
