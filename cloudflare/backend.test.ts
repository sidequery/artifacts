import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { ArtifactHttpResponse } from "../src/httpTypes";

let runtime: Miniflare;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [new URL("./backend-test-worker.ts", import.meta.url).pathname], target: "browser", format: "esm", external: ["cloudflare:workers", "node:*", "fs", "fs/promises"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime = new Miniflare({ cf: false, port: 0, unsafeInspectDurableObjects: true, workers: [{ config: {
    name: "backend-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "test.js", modulesRoot: import.meta.dir, modules: { "test.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: { BACKENDS: { type: "durable-object", worker: "backend-test", exportName: "ArtifactBackend" }, LOADER: { type: "worker-loader" } },
    exports: { ArtifactBackend: { type: "durable-object", storage: "sqlite" } },
  }, dev: {} }] });
  await runtime.ready;
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

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
}`;
}
async function invoke(className: "CanvasServer" | "ArtifactServer", method = "GET") {
  const response = await runtime.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({
    code: compiledServer(className), hash: className, version_id: className,
    request: { path: "/", method, headers: [] },
  }) });
  const result = await response.json() as ArtifactHttpResponse & { error?: string };
  if (!response.ok) throw new Error(result.error);
  expect(result.status).toBe(200);
  return JSON.parse(atob(result.body!));
}

test("cached CanvasServer revisions and new ArtifactServer revisions share native SQLite and KV state", async () => {
  expect(await invoke("CanvasServer", "POST")).toEqual({ exporter: "CanvasServer", count: 7, retained: "original value" });
  expect(await invoke("ArtifactServer")).toEqual({ exporter: "ArtifactServer", count: 7, retained: "original value" });
  await runtime.unsafeEvictDurableObject("backend-test", "ArtifactBackend", { name: "existing" });
  expect(await invoke("ArtifactServer")).toEqual({ exporter: "ArtifactServer", count: 7, retained: "original value" });
  expect(await invoke("CanvasServer")).toEqual({ exporter: "CanvasServer", count: 7, retained: "original value" });
}, 30_000);
