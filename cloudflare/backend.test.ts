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
    cwd: directory, env: { ...process.env, CELLD_ESBUILD: join(import.meta.dir, "../node_modules/.bin/esbuild") }, stdout: "pipe", stderr: "pipe",
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
      vars: { ARTIFACTS_RUNTIME: "celld" },
      durable_objects: { bindings: [{ name: "BACKENDS", class_name: "ArtifactBackend" }, { name: "LIBRARIES", class_name: "ArtifactLibrary" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["ArtifactBackend", "ArtifactLibrary"] }],
      worker_loaders: [{ binding: "LOADER" }],
    }));
    await startNative();
    return;
  }
  runtime = new Miniflare({ cf: false, port: 0, unsafeInspectDurableObjects: true, workers: [{ config: {
    name: "backend-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "test.js", modulesRoot: import.meta.dir, modules: { "test.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: { BACKENDS: { type: "durable-object", worker: "backend-test", exportName: "ArtifactBackend" }, LIBRARIES: { type: "durable-object", worker: "backend-test", exportName: "ArtifactLibrary" }, LOADER: { type: "worker-loader" } },
    exports: { ArtifactBackend: { type: "durable-object", storage: "sqlite" }, ArtifactLibrary: { type: "durable-object", storage: "sqlite" } },
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

function dispatch(path: string, init?: RequestInit) {
  return native ? fetch(url + path, init) : runtime.dispatchFetch("http://localhost" + path, init);
}
async function configure(name: string, secrets: Record<string, string | null>) {
  const response = await dispatch(`/secrets?name=${name}`, { method: "POST", body: JSON.stringify({ secrets }) });
  return { status: response.status, result: await response.json() };
}

test("artifact secrets rotate without losing SQLite, isolate identical source and survive eviction", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => Response.json({ authorization: request.headers.get("authorization") }) });
  const code = `import { DurableObject } from "cloudflare:workers"; import { createHash } from "node:crypto";
export class ArtifactServer extends DurableObject {
  async fetch() {
    this.ctx.storage.sql.exec("create table if not exists visits(n integer)");
    this.ctx.storage.sql.exec("insert into visits values(1)");
    const response = await fetch(${JSON.stringify(upstream.url.href)}, { headers: { authorization: this.env.secrets.TOKEN ?? "missing" } });
    return Response.json({ external: await response.json(), count: this.ctx.storage.sql.exec("select count(*) as n from visits").one().n, hash: createHash("sha256").update("works").digest("hex") });
  }
}
export default { fetch() { return new Response("unused"); } };`;
  async function run(name: string) {
    const response = await dispatch(`/?name=${name}`, { method: "POST", body: JSON.stringify({ code, hash: "identical", request: { path: "/", headers: [] } }) });
    const envelope = await response.json() as ArtifactHttpResponse & { error?: string };
    if (!response.ok) throw new Error(envelope.error);
    return JSON.parse(atob(envelope.body!));
  }
  try {
    expect(await configure("alice", { TOKEN: "alice-token" })).toEqual({ status: 200, result: { ok: true, names: ["TOKEN"] } });
    expect(await configure("bob", { TOKEN: "bob-token" })).toEqual({ status: 200, result: { ok: true, names: ["TOKEN"] } });
    expect(await run("alice")).toMatchObject({ external: { authorization: "alice-token" }, count: 1 });
    expect(await run("bob")).toMatchObject({ external: { authorization: "bob-token" }, count: 1 });
    expect(await configure("alice", { TOKEN: "rotated-token" })).toEqual({ status: 200, result: { ok: true, names: ["TOKEN"] } });
    expect(await run("alice")).toMatchObject({ external: { authorization: "rotated-token" }, count: 2 });
    expect((await configure("alice", { NEW: "should-not-save", invalid: "x".repeat(4097) })).status).toBe(500);
    expect(await (await dispatch("/secrets?name=alice", { method: "POST", body: "{}" })).json()).toEqual({ ok: true, names: ["TOKEN"] });
    if (native) { await stopNative(); await startNative(); }
    else await runtime.unsafeEvictDurableObject("backend-test", "ArtifactBackend", { name: "alice" });
    expect(await run("alice")).toMatchObject({ external: { authorization: "rotated-token" }, count: 3 });
    await configure("alice", { TOKEN: null });
    expect(await run("alice")).toMatchObject({ external: { authorization: "missing" }, count: 4 });
    expect(await run("bob")).toMatchObject({ external: { authorization: "bob-token" }, count: 2 });
  } finally { upstream.stop(true); }
}, native ? 180_000 : 30_000);

test("scheduled backends use current secrets without buffering a streaming response", async () => {
  const name = "scheduled-stream";
  const code = `import { DurableObject } from "cloudflare:workers";
export class ArtifactServer extends DurableObject {
  fetch(request) {
    if (request.method === "GET") return Response.json({ token: this.ctx.storage.kv.get("token") });
    this.ctx.storage.kv.put("token", this.env.secrets.TOKEN);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024)); } }));
  }
}
export default { fetch() { return new Response("unused"); } };`;
  const action = async (path: string, input: object) => {
    const response = await dispatch(`${path}?name=${name}`, { method: "POST", body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    return response.json();
  };
  await configure(name, { TOKEN: "schedule-secret" });
  await action("/activate", { code, hash: "scheduled-stream", version_id: "scheduled-v1", revision: 1 });
  await action("/schedule", { action: "set", interval_seconds: 3600, request: { path: "/", method: "POST" } });
  await action("/schedule", { action: "pause" });
  await action("/schedule", { action: "run_now" });
  const envelope = await action("/", { code, hash: "scheduled-stream", request: { path: "/", method: "GET" } }) as ArtifactHttpResponse;
  expect(JSON.parse(atob(envelope.body!))).toEqual({ token: "schedule-secret" });
  const runs = await (await dispatch(`/runs?name=${name}`)).json();
  expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ revision: "scheduled-v1", trigger: "manual", status: "succeeded" })]));
}, native ? 180_000 : 30_000);

test("native artifact fetch forwards streaming bodies and restores the caller's internal header", async () => {
  let finish!: () => void;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch() {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024).fill(42));
      finish = () => { controller.enqueue(new Uint8Array([7])); controller.close(); };
    } }), { headers: { "content-type": "application/octet-stream", "content-encoding": "identity" } });
  } });
  const code = `import { DurableObject } from "cloudflare:workers";
export class ArtifactServer extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/oversize") return new Response(new Uint8Array(256 * 1024 + 1));
    if (request.method === "POST") return new Response(request.body, { headers: { "x-original": request.headers.get("x-artifacts-backend") ?? "missing" } });
    return fetch(${JSON.stringify(upstream.url.href)});
  }
}
export default { fetch() { return new Response("unused"); } };`;
  try {
    const prepared = await dispatch("/prepare?name=streaming", { method: "POST", body: JSON.stringify({ code }) });
    const { compiled_id } = await prepared.json() as { compiled_id: string };
    const headers = { "x-test-compiled-id": compiled_id, "x-artifacts-backend": "caller-value" };
    const bytes = new Uint8Array(512 * 1024).fill(255);
    const echoed = await dispatch("/api?name=streaming", { method: "POST", headers, body: bytes });
    expect(echoed.headers.get("x-original")).toBe("caller-value");
    expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(bytes);
    const streamed = await dispatch("/api?name=streaming", { headers });
    const reader = streamed.body!.getReader();
    let total = 0;
    while (total < 512 * 1024) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      expect(part.value!.every(value => value === 42)).toBe(true);
      total += part.value!.length;
    }
    // The tail has not been produced yet: receiving the prefix proves no buffering.
    finish();
    expect((await reader.read()).value).toEqual(new Uint8Array([7]));
    expect((await reader.read()).done).toBe(true);
    const bounded = await dispatch("/?name=streaming", { method: "POST", body: JSON.stringify({ code, hash: "streaming", request: { path: "/", method: "POST", headers: [], body: btoa("x".repeat(256 * 1024)) } }) });
    expect(bounded.status).toBe(200);
    const tooLarge = await dispatch("/?name=streaming", { method: "POST", body: JSON.stringify({ code, hash: "streaming", request: { path: "/oversize", method: "POST", headers: [] } }) });
    expect(tooLarge.status).toBe(500);
    expect(await tooLarge.text()).toContain("256 KiB");
  } finally { upstream.stop(true); }
}, native ? 180_000 : 30_000);
