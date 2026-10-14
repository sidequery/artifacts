import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fixture = await readFile(join(import.meta.dir, "../e2e/runtime-plugin-fixture.ts"), "utf8");
let runtime: Miniflare;
let client: Client;
let origin: string;
// Matches the host's per-isolate source cache.
const CACHE_MS = 5_000;

/** The fixture's source under another name, as a separate published plugin. */
const variant = (name: string, replace: [string, string][] = []) =>
  replace.reduce((source, [from, to]) => source.replaceAll(from, to), fixture.replace('name: "test-warehouse"', `name: "${name}"`));

async function publish(name: string, source: string) {
  await (await runtime.getR2Bucket("PLUGINS")).put(`plugins/${name}.ts`, source);
}
async function call(plugin: string, operation: string, input: unknown) {
  const result = await client.callTool({ name: "artifact_plugin_call", arguments: { plugin, operation, input } });
  return { result, payload: JSON.parse((result.content as { text: string }[])[0]!.text) };
}

beforeAll(async () => {
  const modulesRoot = join(import.meta.dir, "../dist/worker-app");
  const modules: Record<string, { type: "esm" | "wasm" | "text"; contents: string | Uint8Array<ArrayBuffer> }> = {};
  for (const name of await readdir(modulesRoot)) {
    if (name.endsWith(".js")) modules[name] = { type: "esm", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".html")) modules[name] = { type: "text", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
  }
  runtime = new Miniflare({ cf: false, port: 0, workers: [{ config: {
    name: "runtime-plugin-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot, modules },
    env: {
      ENVIRONMENT: { type: "text", value: "local" },
      PLUGIN_WAREHOUSE_TOKEN: { type: "text", value: "warehouse-test-token" },
      HOST_ONLY_SECRET: { type: "text", value: "host-only-value" },
      LIBRARIES: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ArtifactLibrary" },
      BACKENDS: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ArtifactBackend" },
      LINKS: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ArtifactLinks" },
      SCRIPTS: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ScriptLibrary" },
      SCRIPT_BACKENDS: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ScriptBackend" },
      FILE_BACKENDS: { type: "durable-object", worker: "runtime-plugin-test", exportName: "ArtifactFiles" },
      FILES: { type: "r2", name: "runtime-plugin-test-files" },
      PLUGINS: { type: "r2", name: "runtime-plugin-test-plugins" },
      LOADER: { type: "worker-loader" },
      ASSETS: { type: "assets" },
    },
    exports: { ArtifactFiles: { type: "durable-object", storage: "sqlite" }, ArtifactLinks: { type: "durable-object", storage: "sqlite" }, ScriptLibrary: { type: "durable-object", storage: "sqlite" }, ScriptBackend: { type: "durable-object", storage: "sqlite" }, ArtifactLibrary: { type: "durable-object", storage: "sqlite" }, ArtifactBackend: { type: "durable-object", storage: "sqlite" } },
    assets: { directory: join(import.meta.dir, "../dist/cloudflare/assets"), hasUserWorker: true, runWorkerFirst: true, htmlHandling: "none" },
  }, dev: {} }] });
  origin = (await runtime.ready).origin;
  await publish("test-warehouse", fixture);
  await publish("test-misconfigured", variant("test-misconfigured", [["PLUGIN_WAREHOUSE_TOKEN", "PLUGIN_MISSING"]]));
  // A published plugin cannot ask for the host's own variables.
  await publish("test-host-secret", variant("test-host-secret", [["PLUGIN_WAREHOUSE_TOKEN", "HOST_ONLY_SECRET"]]));
  await publish("test-misnamed", fixture);
  await publish("test-uncompilable", "export default definePlugin({ name: ");
  await publish("test-external-import", `import { z } from "zod";\nexport const check = z.string();\n${variant("test-external-import")}`);
  client = new Client({ name: "runtime-plugin-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=test`)));
}, 60000);
afterAll(async () => { await client?.close(); await runtime?.dispose(); });

test("published plugin sources are listed beside build-time plugins; invalid ones are left out", async () => {
  const result = await client.callTool({ name: "plugins_list", arguments: {} });
  const plugins = (result.structuredContent as { plugins: { name: string; browser: boolean; operations: { name: string; readOnly: boolean; inputSchema: object }[] }[] }).plugins;
  expect(plugins.map(plugin => plugin.name).sort()).toEqual(["test-misconfigured", "test-warehouse"]);
  const warehouse = plugins.find(plugin => plugin.name === "test-warehouse")!;
  expect(warehouse.browser).toBe(false);
  expect(warehouse.operations.map(operation => [operation.name, operation.readOnly])).toEqual([["query", true], ["restricted", false], ["malformed", false], ["broken", false]]);
  expect(warehouse.operations[0]!.inputSchema).toMatchObject({ required: ["sql"] });
});

test("a call runs in the plugin's own isolate with the caller's identity and only its declared secrets", async () => {
  const { result, payload } = await call("test-warehouse", "query", { sql: "select 1" });
  expect(result.isError, JSON.stringify(payload)).not.toBe(true);
  expect(payload.result).toEqual({
    sql: "select 1", user: { subject: "local", authority: "local" }, secrets: { PLUGIN_WAREHOUSE_TOKEN: "warehouse-test-token" },
    version: "fixture-v1", processEnv: expect.not.arrayContaining(["HOST_ONLY_SECRET", "ENVIRONMENT", "LIBRARIES", "PLUGINS"]),
  });
  // The gallery and hosted-artifact bridge use the same dispatcher.
  const http = await fetch(`${origin}/api/plugins/call?workspace=test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plugin: "test-warehouse", operation: "query", input: { sql: "select 2" } }) });
  expect(http.status).toBe(200);
  expect((await http.json() as { result: { sql: string } }).result.sql).toBe("select 2");
});

test("schema, authorization, handler and configuration failures keep the build-time plugin semantics", async () => {
  const cases: [string, string, unknown, string, number][] = [
    ["test-warehouse", "query", {}, "Invalid plugin input", 400],
    ["test-warehouse", "query", { sql: "select 1", extra: true }, "Invalid plugin input", 400],
    ["test-warehouse", "restricted", {}, "Plugin operation is not allowed", 403],
    ["test-warehouse", "malformed", {}, "Plugin returned invalid output", 500],
    ["test-warehouse", "broken", {}, "Plugin operation failed", 500],
    ["test-warehouse", "missing", {}, "Plugin operation not found", 404],
    ["test-warehouse", "toString", {}, "Plugin operation not found", 404],
    ["not-published", "query", {}, "Plugin operation not found", 404],
    ["test-misconfigured", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    ["test-host-secret", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    ["test-misnamed", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    ["test-uncompilable", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    ["test-external-import", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
  ];
  for (const [plugin, operation, input, error, status] of cases) {
    const { result, payload } = await call(plugin, operation, input);
    expect(result.isError, `${plugin}/${operation}`).toBe(true);
    expect(payload, `${plugin}/${operation}`).toMatchObject({ error, status });
    expect(JSON.stringify(payload)).not.toContain("warehouse-test-token");
    expect(JSON.stringify(payload)).not.toContain("host-only-value");
  }
});

test("republishing the source replaces the running plugin without a host deploy", async () => {
  await publish("test-warehouse", fixture.replace('"fixture-v1"', '"fixture-v2"'));
  await Bun.sleep(CACHE_MS + 500);
  const { payload } = await call("test-warehouse", "query", { sql: "select 1" });
  expect(payload.result.version).toBe("fixture-v2");
}, 20000);
