import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepareCelldConfig } from "../scripts/prepare-celld";
import { spawnCelld, stopCelld, waitForReady, type RunningCelld } from "../e2e/celld-auth-runtime";

const root = resolve(import.meta.dir, "..");
const enabled = process.env.CELLD_INTEGRATION === "1";
const celldTest = enabled ? test : test.skip;
const plugins = { binding: "PLUGINS", bucket_name: "artifacts-plugins" };
let project = "";
let origin = "";
let runtime: RunningCelld | undefined;

function reservePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const selected = listener.port;
  listener.stop(true);
  return selected;
}

beforeAll(async () => {
  if (!enabled) return;
  const binary = process.env.CELLD_BIN ?? Bun.which("celld");
  const esbuild = process.env.CELLD_ESBUILD ?? resolve(root, "node_modules/.bin/esbuild");
  if (!binary) throw new Error("celld was not found; install celld or set CELLD_BIN to its executable");
  if (!existsSync(join(root, "dist/worker-app/worker.js"))) throw new Error("missing dist/worker-app/worker.js; run bun run build:cloudflare");
  const source = await readFile(join(root, "e2e/runtime-plugin-fixture.ts"), "utf8");
  project = await mkdtemp(join(tmpdir(), "artifact-celld-plugins-"));
  await cp(join(root, "dist/worker-app"), join(project, "dist/worker-app"), { recursive: true });
  await cp(join(root, "dist/cloudflare/assets"), join(project, "dist/cloudflare/assets"), { recursive: true });
  const configPath = join(project, "wrangler.jsonc");
  const config = await prepareCelldConfig(join(root, "wrangler.jsonc"), configPath);
  config.r2_buckets = [...(config.r2_buckets as unknown[] ?? []), plugins];
  config.vars = { ...(config.vars as Record<string, unknown>), PLUGIN_WAREHOUSE_TOKEN: "warehouse-test-token", HOST_ONLY_SECRET: "host-only-value" };
  const port = reservePort();
  origin = `http://127.0.0.1:${port}`;
  // Publish through the binding into the project's persistent local storage,
  // as the auth runtime bootstraps D1, then serve Artifacts from that storage.
  await writeFile(join(project, "seed.js"), 'export default { async fetch(request, env) { if (request.method === "PUT") await env.PLUGINS.put(new URL(request.url).searchParams.get("key"), await request.text()); return new Response("ready"); } };\n');
  await writeFile(configPath, JSON.stringify({ name: config.name, main: "seed.js", compatibility_date: config.compatibility_date, r2_buckets: [plugins] }));
  runtime = spawnCelld(binary, esbuild, project, port);
  await waitForReady(runtime, origin);
  const seeded = await fetch(`${origin}/?key=plugins/test-warehouse.ts`, { method: "PUT", body: source });
  if (!seeded.ok) throw new Error(`Seeding failed: ${seeded.status}\n${runtime.logs()}`);
  await stopCelld(runtime);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  runtime = spawnCelld(binary, esbuild, project, port);
  await waitForReady(runtime, `${origin}/health`);
}, 120_000);

afterAll(async () => {
  await stopCelld(runtime);
  if (project) await rm(project, { recursive: true, force: true });
});

celldTest("a published plugin source compiles and runs in its own isolate on celld", async () => {
  const client = new Client({ name: "runtime-plugin-celld", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp?workspace=test`)));
    const listed = await client.callTool({ name: "plugins_list", arguments: {} });
    expect((listed.structuredContent as { plugins: { name: string }[] }).plugins.map(plugin => plugin.name)).toContain("test-warehouse");
    const called = await client.callTool({ name: "artifact_plugin_call", arguments: { plugin: "test-warehouse", operation: "query", input: { sql: "select 1" } } });
    expect(called.isError, JSON.stringify(called.content) + runtime?.logs()).not.toBe(true);
    const result = (called.structuredContent as { result: Record<string, unknown> }).result;
    expect(result).toMatchObject({ sql: "select 1", user: { subject: "local", authority: "local" }, secrets: { PLUGIN_WAREHOUSE_TOKEN: "warehouse-test-token" } });
    expect(result.processEnv).not.toContain("HOST_ONLY_SECRET");
    const invalid = await client.callTool({ name: "artifact_plugin_call", arguments: { plugin: "test-warehouse", operation: "query", input: {} } });
    expect(invalid.structuredContent).toMatchObject({ error: "Invalid plugin input", status: 400 });
  } finally { await client.close(); }
}, 60_000);
