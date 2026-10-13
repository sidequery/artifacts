import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bundleRuntimePlugin } from "../scripts/bundle-plugin";
import { parseRuntimePlugin, type RuntimePluginRecord } from "../src/plugins/runtime";

const fixture = join(import.meta.dir, "../e2e/runtime-plugin-fixture.ts");
let runtime: Miniflare;
let client: Client;
let origin: string;
let record: RuntimePluginRecord;
// Matches the host's per-isolate record cache.
const CACHE_MS = 5_000;

async function publish(key: string, body: string) {
  await (await runtime.getR2Bucket("PLUGINS")).put(key, body);
}
async function call(plugin: string, operation: string, input: unknown) {
  const result = await client.callTool({ name: "artifact_plugin_call", arguments: { plugin, operation, input } });
  return { result, payload: JSON.parse((result.content as { text: string }[])[0]!.text) };
}

beforeAll(async () => {
  record = await bundleRuntimePlugin(fixture);
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
  await publish("plugins/test-warehouse.json", JSON.stringify(record));
  await publish("plugins/test-misconfigured.json", JSON.stringify({ ...record, name: "test-misconfigured", secrets: ["PLUGIN_MISSING"] }));
  await publish("plugins/test-corrupt.json", "{ not json");
  await publish("plugins/test-host-secret.json", JSON.stringify({ ...record, name: "test-host-secret", secrets: ["HOST_ONLY_SECRET"] }));
  client = new Client({ name: "runtime-plugin-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=test`)));
}, 60000);
afterAll(async () => { await client?.close(); await runtime?.dispose(); });

test("the bundle is one self-describing record with schemas and no browser module", () => {
  expect(record).toMatchObject({ format: 1, name: "test-warehouse", secrets: ["PLUGIN_WAREHOUSE_TOKEN"] });
  expect(record.operations.map(operation => [operation.name, operation.readOnly])).toEqual([["query", true], ["restricted", false], ["broken", false]]);
  expect(record.module).not.toContain("warehouse-test-token");
  expect(() => parseRuntimePlugin(record, "other-name")).toThrow("does not match");
  expect(() => parseRuntimePlugin({ ...record, hash: "x" })).toThrow("hash");
});

test("published plugins are listed beside build-time ones; corrupt records are left out", async () => {
  const result = await client.callTool({ name: "plugins_list", arguments: {} });
  const plugins = (result.structuredContent as { plugins: { name: string; browser: boolean; operations: { name: string }[] }[] }).plugins;
  expect(plugins.map(plugin => plugin.name).sort()).toEqual(["test-misconfigured", "test-warehouse"]);
  expect(plugins.find(plugin => plugin.name === "test-warehouse")).toMatchObject({ browser: false, operations: [{ name: "query" }, { name: "restricted" }, { name: "broken" }] });
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

test("schema, authorization and handler failures keep the build-time plugin semantics", async () => {
  const cases: [string, string, unknown, string, number][] = [
    ["test-warehouse", "query", {}, "Invalid plugin input", 400],
    ["test-warehouse", "restricted", {}, "Plugin operation is not allowed", 403],
    ["test-warehouse", "broken", {}, "Plugin operation failed", 500],
    ["test-warehouse", "missing", {}, "Plugin operation not found", 404],
    ["test-warehouse", "toString", {}, "Plugin operation not found", 404],
    ["not-published", "query", {}, "Plugin operation not found", 404],
    ["test-misconfigured", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    ["test-corrupt", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
    // A published record cannot ask for the host's own variables.
    ["test-host-secret", "query", { sql: "select 1" }, "Plugin configuration unavailable", 500],
  ];
  for (const [plugin, operation, input, error, status] of cases) {
    const { result, payload } = await call(plugin, operation, input);
    expect(result.isError, `${plugin}/${operation}`).toBe(true);
    expect(payload, `${plugin}/${operation}`).toMatchObject({ error, status });
    expect(JSON.stringify(payload)).not.toContain("warehouse-test-token");
    expect(JSON.stringify(payload)).not.toContain("host-only-value");
  }
});

test("republishing the record replaces the running plugin without a host deploy", async () => {
  const module = record.module.replace('"fixture-v1"', '"fixture-v2"');
  expect(module).not.toBe(record.module);
  const hash = new Bun.CryptoHasher("sha256").update(module).digest("hex");
  await publish("plugins/test-warehouse.json", JSON.stringify({ ...record, module, hash }));
  await Bun.sleep(CACHE_MS + 500);
  const { payload } = await call("test-warehouse", "query", { sql: "select 1" });
  expect(payload.result.version).toBe("fixture-v2");
}, 20000);
