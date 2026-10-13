import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { chromium } from "playwright";
import { CelldOperator } from "../scripts/native-worker/operator";
import { ARTIFACTS_APP_URI } from "../src/mcp/app-contract";

const integration = process.env.MCP_DISCOVERY_INTEGRATION === "1";
const native = process.env.NATIVE_WORKER_CELLD === "1";
const integrationTest = test.skipIf(!integration);
let runtime: Miniflare;
let operator: CelldOperator;
let directory: string;
let origin: string;
let client: Client;
let other: Client;
let ownerFetch: typeof fetch;
let otherFetch: typeof fetch;
let privateVersion: string;
let restoredPreview: CallToolResult;
let scriptResponse: CallToolResult;
const seen = new Set<string>();
const details = new Map<string, { dispatch: string; inputSchema: unknown }>();

const browserSource = `import { H1, Button, Stack, useArtifactState } from "sidequery/artifacts";
export default function Artifact() {
  const [count, setCount] = useArtifactState("count", 0);
  return <Stack><H1>Nine tool artifact</H1><Button onClick={() => setCount(count + 1)}>Count {count}</Button></Stack>;
}`;
const scriptSource = `export default {
  fetch(request: Request, env: ScriptEnv): Response {
    env.sql.exec("create table if not exists counter (value integer not null)");
    if (!env.sql.exec("select value from counter").toArray().length) env.sql.exec("insert into counter values (0)");
    if (request.method === "POST") env.sql.exec("update counter set value = value + 1");
    return Response.json({ value: env.sql.exec("select value from counter").one().value, token: Boolean(env.secrets.TOKEN), marker: "original" });
  }
};`;

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  return result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text);
}

async function inspect(operation: string) {
  if (!details.has(operation)) {
    const result = await client.callTool({ name: "artifacts_discover", arguments: { operation, include_docs: false } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    details.set(operation, payload(result) as { dispatch: string; inputSchema: unknown });
  }
  return details.get(operation)!;
}

async function invoke(operation: string, args: Record<string, unknown> = {}, via?: string) {
  const definition = await inspect(operation);
  const direct = ["artifact_guide", "artifact_list", "artifact_read", "artifact_write", "artifact_edit", "artifact_open"].includes(operation);
  const result = await client.callTool({ name: via ?? (direct ? operation : definition.dispatch),
    arguments: via || !direct ? { operation, arguments: args } : args });
  expect(result.isError, `${operation}: ${JSON.stringify(result)}`).not.toBe(true);
  seen.add(operation);
  return result;
}

beforeAll(async () => {
  if (!integration) return;
  directory = await mkdtemp(join(tmpdir(), "compact-mcp-"));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "compact-mcp", alg: "RS256", use: "sig" };
  const assertion = (subject: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(subject)
    .setIssuer("https://compact-fixture.cloudflareaccess.com").setAudience("compact-mcp").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const modulesRoot = join(import.meta.dir, "../dist/worker-app");
  const modules: Record<string, { type: "esm" | "wasm" | "text"; contents: string | Uint8Array }> = {};
  for (const name of await readdir(modulesRoot)) {
    if (name.endsWith(".js") || name.endsWith(".html")) modules[name] = { type: name.endsWith(".js") ? "esm" : "text", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
  }
  const variables: Record<string, string> = { AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "compact-fixture.cloudflareaccess.com", ACCESS_AUD: "compact-mcp" };
  if (native) {
    const token = "compact-operator-fixture-token-32-characters";
    operator = new CelldOperator({ root: join(directory, "operator"), token, binary: process.env.CELLD_BIN });
    await operator.start();
    variables.NATIVE_CELLD_OPERATOR_URL = operator.serve({ port: 0 }).url.origin + "/";
    variables.NATIVE_CELLD_OPERATOR_TOKEN = token;
    variables.NATIVE_CELLD_TRUSTED_APPS = "true";
  }
  const env: Record<string, any> = Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, { type: "text", value }]));
  const exports: Record<string, any> = {};
  for (const [binding, className] of Object.entries({ LIBRARIES: "ArtifactLibrary", BACKENDS: "ArtifactBackend", LINKS: "ArtifactLinks", SCRIPTS: "ScriptLibrary", SCRIPT_BACKENDS: "ScriptBackend", FILE_BACKENDS: "ArtifactFiles", NATIVE_APPS: "NativeApps" })) {
    env[binding] = { type: "durable-object", worker: "compact", exportName: className };
    exports[className] = { type: "durable-object", storage: "sqlite" };
  }
  env.FILES = { type: "r2", name: "compact-files" }; env.LOADER = { type: "worker-loader" }; env.ASSETS = { type: "assets" };
  runtime = new Miniflare({ cf: false, port: 0, workers: [{ config: {
    name: "compact", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot, modules }, env, exports,
    assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" },
  }, dev: { outboundService: { type: "fetcher", handler: async (request: Request) => {
    if (request.url === "https://compact-fixture.cloudflareaccess.com/cdn-cgi/access/certs") return new RuntimeResponse(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
    return new RuntimeResponse(response.body, { status: response.status, headers: response.headers });
  } } } }] } as ConstructorParameters<typeof Miniflare>[0]);
  origin = (await runtime.ready).origin;
  const connect = async (subject: string) => {
    const token = await assertion(subject);
    const connected = new Client({ name: "compact-mcp-integration", version: "1" });
    const authenticatedFetch: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", token); headers.set("Connection", "close");
      return fetch(input, { ...init, headers });
    };
    if (subject === "local") ownerFetch = authenticatedFetch;
    else otherFetch = authenticatedFetch;
    await connected.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=compact`), {
      fetch: authenticatedFetch,
    }));
    return connected;
  };
  client = await connect("local");
  other = await connect("other-user");
}, 90_000);

afterAll(async () => {
  await client?.close(); await other?.close(); await runtime?.dispose(); await operator?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

integrationTest("one HTTP MCP connection discovers all 48 operations and performs complete artifact, script and native app workflows", async () => {
  const listed = (await client.listTools()).tools;
  const model = listed.filter(tool => !((tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility?.every(scope => scope === "app")));
  expect(model.map(tool => tool.name).sort()).toEqual([
    "artifact_edit", "artifact_guide", "artifact_list", "artifact_open", "artifact_read", "artifact_write",
    "artifacts_discover", "artifacts_execute", "artifacts_query",
  ]);
  const catalog = payload(await client.callTool({ name: "artifacts_discover", arguments: { limit: 50 } }));
  expect(catalog.total).toBe(48);
  for (const operation of catalog.operations) await inspect(operation.operation);
  const backend = await readFile(join(import.meta.dir, "../examples/counter.artifact.server.ts"), "utf8");
  const guide = await invoke("artifact_guide");
  expect(JSON.stringify(guide.content)).not.toContain("Hosted standalone scripts and root URLs");
  expect(JSON.stringify(guide.content)).not.toContain("## Hosted servers and SQLite");
  const created = await invoke("artifact_write", { name: "compact-artifact", contents: browserSource, server: backend });
  privateVersion = (created._meta!.artifact as { versionId: string }).versionId;
  await invoke("artifact_list");
  const read = payload(await invoke("artifact_read", { name: "compact-artifact" }));
  await invoke("artifact_edit", { name: "compact-artifact", expected_hash: read.source_hash, edits: [{ old_text: "Nine tool artifact", new_text: "Edited artifact" }] });
  await invoke("artifact_open", { name: "compact-artifact" });
  restoredPreview = await invoke("artifact_restore", { version_id: privateVersion }) as CallToolResult;
  expect((restoredPreview._meta!.artifact as { js: string }).js).toContain("Nine tool artifact");
  await invoke("artifact_history", { name: "compact-artifact" });
  await invoke("artifact_version", { version_id: privateVersion });
  await invoke("artifact_typecheck", { name: "compact-artifact" });
  await invoke("artifact_compile", { name: "compact-artifact" });
  await invoke("artifact_remix", { name: "compact-artifact", new_name: "compact-remix" });
  const archive = payload(await invoke("artifact_export", { name: "compact-artifact" }));
  await invoke("artifact_import", { new_name: "compact-import", archive });
  await invoke("artifact_link", { name: "compact-artifact", kind: "artifact", slug: "compact-artifact" });
  await invoke("artifact_secrets", { name: "compact-artifact", secrets: { TOKEN: "artifact-fixture-value" } });
  const names = payload(await invoke("artifact_secrets", { name: "compact-artifact" }, "artifacts_query"));
  expect(names.names).toEqual(["TOKEN"]);
  await invoke("artifact_request", { name: "compact-artifact", request: { path: "/counter", method: "POST" } });
  await invoke("artifact_schedule", { name: "compact-artifact", action: "set", interval_seconds: 86400, request: { path: "/counter", method: "POST" } });
  await invoke("artifact_schedule", { name: "compact-artifact", action: "pause" });
  await invoke("artifact_schedule", { name: "compact-artifact", action: "run_now" });
  const schedule = payload(await invoke("artifact_schedule", { name: "compact-artifact" }, "artifacts_query"));
  expect(JSON.stringify(schedule)).toContain("86400");
  const runs = payload(await invoke("artifact_runs", { name: "compact-artifact" }));
  expect(runs.runs.length).toBeGreaterThan(0);
  const upload = payload(await invoke("artifact_files", { name: "compact-artifact", request: { operation: "upload", name: "fixture.txt", size: 5, type: "text/plain" } })).result;
  expect((await fetch(upload.url, { method: "PUT", body: "hello" })).ok).toBe(true);
  const files = payload(await invoke("artifact_files", { name: "compact-artifact", request: { operation: "list" } }, "artifacts_query")).result;
  expect(files.files).toHaveLength(1);
  const download = payload(await invoke("artifact_files", { name: "compact-artifact", request: { operation: "download", id: upload.file.id } }, "artifacts_query")).result;
  expect(await (await fetch(download.url)).text()).toBe("hello");
  await invoke("artifact_files", { name: "compact-artifact", request: { operation: "delete", id: upload.file.id } });

  await invoke("script_guide");
  await invoke("script_write", { name: "compact-script", contents: scriptSource });
  await invoke("script_list");
  const scriptRead = payload(await invoke("script_read", { name: "compact-script" }));
  const history = payload(await invoke("script_history", { name: "compact-script" }));
  await invoke("script_version", { version_id: history.versions[0].id });
  await invoke("script_edit", { name: "compact-script", expected_hash: scriptRead.source_hash, edits: [{ old_text: 'marker: "original"', new_text: 'marker: "edited"' }] });
  await invoke("script_restore", { name: "compact-script", version_id: history.versions[0].id });
  await invoke("script_secrets", { name: "compact-script", secrets: { TOKEN: "script-fixture-value" } });
  scriptResponse = await invoke("script_run", { name: "compact-script", request: { path: "/compact-script", method: "POST" } }) as CallToolResult;
  expect(JSON.parse(atob(payload(scriptResponse).response.body))).toMatchObject({ value: 1, token: true, marker: "original" });
  await invoke("script_schedule", { name: "compact-script", action: "set", interval_seconds: 86400, request: { path: "/compact-script", method: "POST" } });
  await invoke("script_schedule", { name: "compact-script", action: "pause" });
  await invoke("script_schedule", { name: "compact-script", action: "run_now" });
  await invoke("script_schedule", { name: "compact-script" }, "artifacts_query");
  await invoke("script_runs", { name: "compact-script" });
  await invoke("script_logs", { name: "compact-script" });
  await invoke("script_remix", { name: "compact-script", new_name: "compact-script-remix" });
  const scriptArchive = payload(await invoke("script_export", { name: "compact-script" }));
  await invoke("script_import", { new_name: "compact-script-import", archive: scriptArchive });
  expect(JSON.stringify(scriptArchive)).not.toContain("script-fixture-value");

  await invoke("plugin_guide");
  const plugins = payload(await invoke("plugins_list"));
  expect(plugins.plugins.some((plugin: { name: string }) => plugin.name === "mcp-discovery-test")).toBe(true);
  expect(payload(await invoke("artifact_plugin_call", { plugin: "mcp-discovery-test", operation: "echo", input: { value: "authorized" } })).result).toEqual({ value: "authorized" });

  if (native) {
    await invoke("app_guide");
    await invoke("app_list");
    const source = 'export default { fetch() { return new Response("native-original"); } };';
    const manifest = { main: "worker.ts", compatibility_date: "2026-09-06", vars: {}, secrets: [], bindings: {}, triggers: {} };
    await invoke("app_write", { name: "compact-native", source, manifest, provider: "celld-local", expected_revision: null });
    const appUrl = `${origin}/apps/compact-native/?workspace=compact`;
    expect(await (await ownerFetch(appUrl)).text()).toBe("native-original");
    const appRead = payload(await invoke("app_read", { name: "compact-native" }));
    await invoke("app_history", { name: "compact-native" });
    await invoke("app_write", { name: "compact-native", source: source.replace("native-original", "native-updated"), manifest, expected_revision: appRead.revision_token });
    expect(await (await ownerFetch(appUrl)).text()).toBe("native-updated");
    await invoke("app_restore", { name: "compact-native", revision_id: appRead.active_revision });
    expect(await (await ownerFetch(appUrl)).text()).toBe("native-original");
    await invoke("app_secrets", { name: "compact-native", secrets: {} });
    await invoke("app_secrets", { name: "compact-native" }, "artifacts_query");
    await invoke("app_reconcile", { name: "compact-native" });
    await invoke("app_move", { name: "compact-native", library: "team" });
    expect((await ownerFetch(appUrl)).status).toBe(404);
    expect(await (await otherFetch(appUrl + "&library=team")).text()).toBe("native-original");
  }
  const expected = catalog.operations.map((operation: { operation: string }) => operation.operation).filter((name: string) => native || !name.startsWith("app_"));
  expect([...seen].sort()).toEqual(expected.sort());
  expect((await client.listTools()).tools).toEqual(listed);
}, 180_000);

integrationTest("query and nested schema guards reject side effects without changing script state", async () => {
  for (const input of [
    { operation: "script_run", arguments: { name: "compact-script", request: { path: "/", method: "GET" } } },
    { operation: "artifact_request", arguments: { name: "compact-artifact", request: { path: "/counter", method: "GET" } } },
    { operation: "script_schedule", arguments: { name: "compact-script", action: "run_now" } },
    { operation: "script_secrets", arguments: { name: "compact-script", secrets: { TOKEN: null } } },
    { operation: "artifact_plugin_call", arguments: { plugin: "mcp-discovery-test", operation: "echo", input: { value: "read" } } },
  ]) {
    const result = await client.callTool({ name: "artifacts_query", arguments: input });
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain("Use artifacts_execute");
  }
  const malformed = await client.callTool({ name: "artifacts_execute", arguments: { operation: "script_write", arguments: { name: "compact-script" } } });
  expect(malformed.isError).toBe(true);
  expect(payload(malformed).error).toContain("Invalid arguments for script_write");
  const result = await invoke("script_run", { name: "compact-script", request: { path: "/", method: "GET" } });
  expect(JSON.parse(atob(payload(result).response.body))).toMatchObject({ value: 2, token: true });
  for (const operation of ["artifacts_execute", "artifacts_tool", "artifacts_source", "artifacts_settings_update", "constructor"]) {
    expect((await client.callTool({ name: "artifacts_execute", arguments: { operation, arguments: {} } })).isError).toBe(true);
  }
});

integrationTest("dispatch preserves authenticated ownership, revision access and plugin authorization", async () => {
  // Authentication rejects before reading the body; do not pool that socket
  // with the authenticated MCP clients used for the following access probes.
  expect((await fetch(`${origin}/mcp`, { method: "POST", headers: { Connection: "close" }, body: "{}" })).status).toBe(401);
  for (const [name, operation, argumentsValue] of [
    ["artifacts_query", "artifact_version", { version_id: privateVersion }],
    ["artifacts_query", "artifact_files", { version_id: privateVersion, request: { operation: "list" } }],
    ["artifacts_execute", "artifact_restore", { version_id: privateVersion }],
    ["artifacts_execute", "artifact_plugin_call", { plugin: "mcp-discovery-test", operation: "echo", input: { value: "denied" } }],
  ] as const) {
    const result = await other.callTool({ name, arguments: { operation, arguments: argumentsValue } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Nine tool artifact");
    expect(JSON.stringify(result)).not.toContain("artifact-fixture-value");
  }
  const forged = await other.callTool({ name: "artifacts_query", arguments: { operation: "artifact_read", arguments: { name: "compact-artifact", owner: "local" } } });
  expect(payload(forged).error).toContain("Invalid arguments");
  expect(payload(await other.callTool({ name: "artifact_list", arguments: {} })).artifacts).toEqual([]);
});

integrationTest("real execution results render inline previews and completed non-preview actions through the MCP App bridge", async () => {
  const resource = await client.readResource({ uri: ARTIFACTS_APP_URI });
  const html = resource.contents[0]!.text as string;
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../e2e/mcp-app-host.ts")], target: "browser", format: "esm" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const hostHtml = `<!doctype html><html><body><iframe id="app" sandbox="allow-scripts allow-forms"></iframe><script>window.artifactAppHtml=${JSON.stringify(html).replace(/<\/script/gi, "<\\/script")};</script><script type="module">${(await build.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  const server = Bun.serve({ port: 0, fetch: () => new Response(hostHtml, { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.mcpHost?.initialized);
    const app = page.frameLocator("#app");
    await page.evaluate(result => window.mcpHost!.sendResult(result), scriptResponse);
    await app.locator("#status").getByText('"status"', { exact: false }).waitFor();
    expect(await app.locator("#status").innerText()).not.toContain("Waiting for artifact");
    await page.evaluate(result => window.mcpHost!.sendResult(result), restoredPreview);
    await app.getByRole("heading", { name: "Nine tool artifact" }).waitFor();
    await app.getByRole("button", { name: "Count 0", exact: true }).click();
    await app.getByRole("button", { name: "Count 1", exact: true }).waitFor();
    await page.evaluate(result => window.mcpHost!.sendResult(result), scriptResponse);
    expect(await app.getByRole("button", { name: "Count 1", exact: true }).count()).toBe(1);
  } finally { await page.close(); await browser.close(); server.stop(true); }
}, 30_000);
