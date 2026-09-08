import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCelldRuntime } from "../src/local/celld-runtime";
import { Miniflare } from "miniflare";
import type { ArtifactHttpResponse } from "../src/httpTypes";

let runtime: Miniflare;
const native = process.env.CELLD_BACKEND_INTEGRATION === "1";
let directory = "", binary = "", url = "", logs = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
async function startNative() {
  child = Bun.spawn([binary, "dev", directory, "--host", "127.0.0.1", "--port", new URL(url).port, "--no-watch"], {
    cwd: directory, env: { ...process.env, CELLD_WORKER_LOADER: "LOADER", CELLD_ESBUILD: join(import.meta.dir, "../node_modules/.bin/esbuild") }, stdout: "pipe", stderr: "pipe",
  });
  for (const stream of [child.stdout, child.stderr]) if (typeof stream !== "number") void (async () => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
  })();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try { if ((await fetch(url + "/health")).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("celld did not become ready: " + logs);
}
async function stopNative() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!stopped) { child.kill("SIGKILL"); await child.exited; }
  child = undefined;
}
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [new URL("./backend-test-worker.ts", import.meta.url).pathname], target: "browser", format: "esm", external: ["cloudflare:workers", "node:*", "fs", "fs/promises"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  if (native) {
    directory = await mkdtemp(join(tmpdir(), "artifact-backend-celld-"));
    binary = process.env.CELLD_BIN ?? await ensureCelldRuntime({ dataRoot: join(directory, "runtime") });
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    url = `http://127.0.0.1:${listener.port}`;
    listener.stop(true);
    await Bun.write(join(directory, "worker.js"), await build.outputs[0]!.text());
    await Bun.write(join(directory, "wrangler.jsonc"), JSON.stringify({ name: "backend-test", main: "worker.js", compatibility_date: "2026-09-06", compatibility_flags: ["nodejs_compat"],
      durable_objects: { bindings: [{ name: "BACKENDS", class_name: "ArtifactBackend" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["ArtifactBackend"] }],
    }));
    await startNative();
    return;
  }
  runtime = new Miniflare({ cf: false, port: 0, unsafeInspectDurableObjects: true, workers: [{ config: {
    name: "backend-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "test.js", modulesRoot: import.meta.dir, modules: { "test.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: { BACKENDS: { type: "durable-object", worker: "backend-test", exportName: "ArtifactBackend" }, LOADER: { type: "worker-loader" } },
    exports: { ArtifactBackend: { type: "durable-object", storage: "sqlite" } },
  }, dev: {} }] });
  await runtime.ready;
}, 180_000);
afterAll(async () => { await runtime?.dispose(); await stopNative(); if (directory) await rm(directory, { recursive: true, force: true }); });

// Already compiled JavaScript, bypassing the source compiler and its export normalization.
function compiledServer(className: "CanvasServer" | "ArtifactServer") {
  return `import { DurableObject } from "cloudflare:workers";
export class ${className} extends DurableObject {
  async fetch(request) {
    const sql = this.ctx.storage.sql;
    sql.exec("create table if not exists counter (value integer not null)");
    if (request.method === "POST") {
      sql.exec("insert into counter values (?)", 7);
      await this.ctx.storage.put("retained", "original value");
    }
    return Response.json({ exporter: "${className}", count: sql.exec("select sum(value) as total from counter").one().total, retained: await this.ctx.storage.get("retained") });
  }
}
export default { fetch() { return new Response("Not found", { status: 404 }); } };`;
}
async function invoke(className: "CanvasServer" | "ArtifactServer", method = "GET") {
  const dispatch = native ? (input: string, init: RequestInit) => fetch(url + new URL(input).pathname, init) : (input: string, init: RequestInit) => runtime.dispatchFetch(input, init);
  const response = await dispatch("http://localhost/", { method: "POST", body: JSON.stringify({
    code: compiledServer(className), hash: className, version_id: className,
    request: { path: "/", method, headers: [] },
  }) });
  const result = await response.json() as ArtifactHttpResponse & { error?: string };
  if (!response.ok) throw new Error(result.error + (native ? "\n" + logs : ""));
  expect(result.status).toBe(200);
  return JSON.parse(atob(result.body!));
}

test("cached CanvasServer revisions and new ArtifactServer revisions share native SQLite and KV state", async () => {
  expect(await invoke("CanvasServer", "POST")).toEqual({ exporter: "CanvasServer", count: 7, retained: "original value" });
  expect(await invoke("ArtifactServer")).toEqual({ exporter: "ArtifactServer", count: 7, retained: "original value" });
  if (native) { await stopNative(); await startNative(); }
  else await runtime.unsafeEvictDurableObject("backend-test", "ArtifactBackend", { name: "existing" });
  expect(await invoke("ArtifactServer")).toEqual({ exporter: "ArtifactServer", count: 7, retained: "original value" });
  expect(await invoke("CanvasServer")).toEqual({ exporter: "CanvasServer", count: 7, retained: "original value" });
}, native ? 180_000 : 30_000);
