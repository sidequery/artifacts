import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { request as httpRequest } from "node:http";
import type { CanvasFile, CanvasFileList } from "../src/sdk/files";

let runtime: Miniflare;
type Grant = { file: CanvasFile; path: string; expires: string };

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./files-test-worker.ts", import.meta.url).pathname],
    target: "node", format: "esm", external: ["cloudflare:workers"],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime = new Miniflare({
    cf: false, port: 0, unsafeInspectDurableObjects: true,
    workers: [{ config: {
      name: "canvas-files-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
      manifest: {
        mainModule: "files-test-worker.js", modulesRoot: import.meta.dir,
        modules: { "files-test-worker.js": { type: "esm", contents: await build.outputs[0]!.text() } },
      },
      env: {
        FILES: { type: "r2", name: "canvas-files-test" },
        FILE_BACKENDS: { type: "durable-object", worker: "canvas-files-test", exportName: "CanvasFiles" },
      },
      exports: { CanvasFiles: { type: "durable-object", storage: "sqlite" } },
    }, dev: {} }],
  });
  await runtime.ready;
}, 30_000);

afterAll(async () => { await runtime?.dispose(); });

function request(scope: string, input: unknown) {
  return runtime.dispatchFetch(`http://localhost/request?scope=${encodeURIComponent(scope)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
}
async function call<T>(scope: string, input: unknown): Promise<T> {
  const response = await request(scope, input);
  const payload = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload as T;
}
function grant(scope: string, size: number, name = "data.bin", type = "application/octet-stream") {
  return call<Grant>(scope, { operation: "upload", name, size, type });
}
function transfer(path: string, method = "GET", body?: Uint8Array) {
  return runtime.dispatchFetch(`http://localhost${path}`, {
    method, ...(body ? { body, headers: { "content-length": String(body.byteLength) } } : {}),
  });
}
async function list(scope: string) { return call<CanvasFileList>(scope, { operation: "list" }); }

test("native R2 roundtrips 2 MiB binary data, metadata, UTF-8 attachment names, and deletion", async () => {
  const scope = "roundtrip";
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
  const upload = await grant(scope, bytes.length, "résumé 東京's.bin");
  expect(Date.parse(upload.expires) - Date.now()).toBeGreaterThan(290_000);
  expect(Date.parse(upload.expires) - Date.now()).toBeLessThanOrEqual(300_000);
  expect(await list(scope)).toEqual({ files: [] });
  const written = await transfer(upload.path, "PUT", bytes);
  expect(written.status).toBe(201);
  const { file } = await written.json() as { file: CanvasFile };
  expect(file).toMatchObject({ id: upload.file.id, name: upload.file.name, size: bytes.length, type: "application/octet-stream" });
  expect(Number.isNaN(Date.parse(file.uploaded))).toBe(false);
  expect(await list(scope)).toEqual({ files: [file] });
  const download = await call<Grant>(scope, { operation: "download", id: file.id });
  const response = await transfer(download.path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"download\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%E6%9D%B1%E4%BA%AC%27s.bin");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  const head = await transfer(download.path, "HEAD");
  expect(head.status).toBe(200);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  expect(await call(scope, { operation: "delete", id: file.id })).toEqual({ deleted: true });
  expect(await list(scope)).toEqual({ files: [] });
  expect((await transfer(download.path)).status).toBe(404);
});

test("separate canvas scopes isolate identical filenames and cannot select each other's IDs or grants", async () => {
  const first = await grant("scope-a", 1);
  const second = await grant("scope-b", 1);
  expect((await transfer(first.path, "PUT", new Uint8Array([1]))).status).toBe(201);
  expect((await transfer(second.path, "PUT", new Uint8Array([2]))).status).toBe(201);
  expect((await list("scope-a")).files.map(file => file.id)).toEqual([first.file.id]);
  expect((await list("scope-b")).files.map(file => file.id)).toEqual([second.file.id]);
  expect((await request("scope-b", { operation: "download", id: first.file.id })).status).toBe(400);
  await call("scope-b", { operation: "delete", id: first.file.id });
  expect((await list("scope-a")).files).toHaveLength(1);
  const download = await call<Grant>("scope-a", { operation: "download", id: first.file.id });
  const transplanted = download.path.replace(download.path.split("/")[5]!, second.path.split("/")[5]!);
  expect((await transfer(transplanted)).status).toBe(404);
});

test("upload grants enforce method and size, preserve no pending objects, and consume once under concurrent PUTs", async () => {
  const upload = await grant("single-use", 3);
  expect((await transfer(upload.path)).status).toBe(405);
  expect((await transfer(upload.path, "PUT", new Uint8Array([1, 2]))).status).toBe(400);
  expect(await list("single-use")).toEqual({ files: [] });
  const responses = await Promise.all([
    transfer(upload.path, "PUT", new Uint8Array([1, 2, 3])),
    transfer(upload.path, "PUT", new Uint8Array([4, 5, 6])),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 404]);
  expect((await transfer(upload.path, "PUT", new Uint8Array([7, 8, 9]))).status).toBe(404);
  const download = await call<Grant>("single-use", { operation: "download", id: upload.file.id });
  expect((await transfer(download.path, "PUT", new Uint8Array([7, 8, 9]))).status).toBe(405);
  const actual = new Uint8Array(await (await transfer(download.path)).arrayBuffer());
  expect(actual).toEqual(responses[0]!.status === 201 ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5, 6]));
});

test("zero-byte uploads and issued grants survive Durable Object eviction", async () => {
  const scope = "eviction";
  const upload = await grant(scope, 0, "empty.txt", "");
  await runtime.unsafeEvictDurableObject("canvas-files-test", "CanvasFiles", { name: scope });
  // dispatchFetch drops content-length for an empty typed array; exercise real HTTP instead.
  const emptyPut = await fetch(new URL(upload.path, await runtime.ready), { method: "PUT", headers: { "content-length": "0" }, body: new Uint8Array() });
  expect({ status: emptyPut.status, body: await emptyPut.json() }).toMatchObject({ status: 201 });
  const download = await call<Grant>(scope, { operation: "download", id: upload.file.id });
  await runtime.unsafeEvictDurableObject("canvas-files-test", "CanvasFiles", { name: scope });
  expect((await list(scope)).files[0]).toMatchObject({ id: upload.file.id, size: 0, type: "application/octet-stream" });
  const response = await transfer(download.path);
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test("expired grants cannot transfer and cleanup removes them without deleting stored files", async () => {
  const scope = "expiry";
  const uploaded = await grant(scope, 1);
  await transfer(uploaded.path, "PUT", new Uint8Array([42]));
  const download = await call<Grant>(scope, { operation: "download", id: uploaded.file.id });
  const pending = await grant(scope, 1, "pending.bin");
  const storage = await runtime.unsafeGetDurableObjectStorage("canvas-files-test", "CanvasFiles", { name: scope });
  await storage.exec("update file_grants set expires = 0");
  expect((await transfer(download.path)).status).toBe(404);
  expect((await transfer(pending.path, "PUT", new Uint8Array([1]))).status).toBe(404);
  const alarm = await runtime.dispatchFetch(`http://localhost/alarm?scope=${scope}`, { method: "POST" });
  expect({ status: alarm.status, body: await alarm.json() }).toMatchObject({ status: 200 });
  expect(await storage.exec("select token from file_grants")).toEqual([]);
  expect((await list(scope)).files.map(file => file.id)).toEqual([uploaded.file.id]);
});

test("invalid names, IDs, request shapes, and sizes above 25 MiB are rejected before storing files", async () => {
  for (const name of ["", " ", ".", "..", "../file", "a/b", "a\\b", "a\n", "a\0", "é".repeat(128)]) {
    const response = await request("invalid", { operation: "upload", name, size: 0, type: "" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("File name");
  }
  for (const operation of ["download", "delete"]) {
    for (const id of ["../escape", "not-an-id", "00000000-0000-0000-0000-000000000000"]) {
      expect((await request("invalid", { operation, id })).status).toBe(400);
    }
  }
  for (const size of [-1, 0.5, 25 * 1024 * 1024 + 1]) {
    expect((await request("invalid", { operation: "upload", name: "file", size, type: "" })).status).toBe(400);
  }
  expect((await request("invalid", { operation: "upload", name: "file", size: 0, type: "text/plain\r\nx: y" })).status).toBe(400);
  expect((await request("invalid", { operation: "list", key: "foreign-prefix" })).status).toBe(400);
  expect(await list("invalid")).toEqual({ files: [] });
});

test.each([false, true])("deleting an in-flight upload prevents resurrection, including cleanup failure=%s", async cleanupFailure => {
  const scope = `delete-during-upload-${cleanupFailure}`;
  const upload = await grant(scope, 2);
  const storage = await runtime.unsafeGetDurableObjectStorage("canvas-files-test", "CanvasFiles", { name: scope });
  let resolveResponse!: (value: { status: number; body: string }) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const pending = httpRequest(new URL(upload.path, await runtime.ready), {
    method: "PUT", headers: { "content-length": "2" },
  }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => resolveResponse({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString() }));
    incoming.on("error", rejectResponse);
  });
  pending.on("error", rejectResponse);
  // Retain the response rejection while assertions run and the request remains open.
  void response.catch(() => {});
  try {
    pending.write(Buffer.from([1]));
    const deadline = Date.now() + 5_000;
    let rows: { id: string; canceled: number }[] = [];
    while (Date.now() < deadline) {
      rows = await storage.exec<{ id: string; canceled: number }>("select id, canceled from file_uploads");
      if (rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(rows).toEqual([{ id: upload.file.id, canceled: 0 }]);
    expect(await list(scope)).toEqual({ files: [] });
    expect((await request(scope, { operation: "download", id: upload.file.id })).status).toBe(400);
    expect(await call(scope, { operation: "delete", id: upload.file.id })).toEqual({ deleted: true });
    expect(await storage.exec("select canceled from file_uploads")).toEqual([{ canceled: 1 }]);
    if (cleanupFailure) {
      expect((await runtime.dispatchFetch(`http://localhost/fail-next-delete?scope=${scope}`, { method: "POST" })).status).toBe(200);
    }
    pending.end(Buffer.from([2]));
    expect(await response).toEqual(cleanupFailure
      ? { status: 500, body: JSON.stringify({ error: "File transfer failed" }) }
      : { status: 409, body: JSON.stringify({ error: "Upload was canceled" }) });
    expect(await list(scope)).toEqual({ files: [] });
    const bucket = await runtime.getR2Bucket("FILES", "canvas-files-test");
    const key = `canvases/${upload.path.split("/")[5]}/${upload.file.id}`;
    if (cleanupFailure) {
      expect(await bucket.head(key)).not.toBeNull();
      expect((await request(scope, { operation: "download", id: upload.file.id })).status).toBe(400);
      const retained = await storage.exec<{ id: string; canceled: number; expires: number }>("select * from file_uploads");
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ id: upload.file.id, canceled: 1 });
      expect(retained[0]!.expires - Date.now()).toBeGreaterThan(50_000);
      expect(retained[0]!.expires - Date.now()).toBeLessThanOrEqual(60_000);
      await storage.exec("update file_uploads set expires = 0");
      expect((await runtime.dispatchFetch(`http://localhost/alarm?scope=${scope}`, { method: "POST" })).status).toBe(200);
    }
    expect(await storage.exec("select id from file_uploads")).toEqual([]);
    expect(await bucket.head(key)).toBeNull();
  } finally {
    pending.destroy();
  }
});

test("R2 pagination returns every scoped file once and preserves metadata across pages", async () => {
  const scope = "pagination";
  const upload = await grant(scope, 0);
  const prefix = `canvases/${upload.path.split("/")[5]}/`;
  const bucket = await runtime.getR2Bucket("FILES", "canvas-files-test");
  const ids = Array.from({ length: 105 }, () => crypto.randomUUID()).sort();
  await Promise.all(ids.map(id => bucket.put(prefix + id, new Uint8Array([7]), {
    customMetadata: { name: `${id}.txt` }, httpMetadata: { contentType: "text/plain" },
  })));
  await bucket.put("canvases/foreign/hidden", "private");
  const first = await list(scope);
  expect(first.files).toHaveLength(100);
  expect(first.cursor).toBeString();
  const last = await call<CanvasFileList>(scope, { operation: "list", cursor: first.cursor });
  expect(last.files).toHaveLength(5);
  expect(last.cursor).toBeUndefined();
  expect([...first.files, ...last.files].map(file => file.id)).toEqual(ids);
  expect([...first.files, ...last.files].every(file => file.name === `${file.id}.txt` && file.size === 1 && file.type === "text/plain")).toBe(true);
});

test("pending grants are capped at 128 and expired grants free capacity", async () => {
  const scope = "quota";
  for (let index = 0; index < 128; index++) await grant(scope, 0);
  const denied = await request(scope, { operation: "upload", name: "over-quota", size: 0, type: "" });
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain("Too many pending file transfers");
  const storage = await runtime.unsafeGetDurableObjectStorage("canvas-files-test", "CanvasFiles", { name: scope });
  await storage.exec("update file_grants set expires = 0");
  expect((await grant(scope, 0)).file.size).toBe(0);
  expect(await storage.exec("select count(*) as count from file_grants")).toEqual([{ count: 1 }]);
  expect(await list(scope)).toEqual({ files: [] });
});

test("cleanup reclaims stale uploaded objects while retaining live uploads and completed files", async () => {
  const scope = "stale-uploads";
  const completed = await grant(scope, 1);
  expect((await transfer(completed.path, "PUT", new Uint8Array([1]))).status).toBe(201);
  const prefix = `canvases/${completed.path.split("/")[5]}/`;
  const bucket = await runtime.getR2Bucket("FILES", "canvas-files-test");
  const staleId = crypto.randomUUID();
  const activeId = crypto.randomUUID();
  await bucket.put(prefix + staleId, "stale");
  await bucket.put(prefix + activeId, "active");
  const storage = await runtime.unsafeGetDurableObjectStorage("canvas-files-test", "CanvasFiles", { name: scope });
  await storage.exec("insert into file_uploads values (?, 0, 0), (?, 0, ?)", staleId, activeId, Date.now() + 600_000);
  expect((await list(scope)).files.map(file => file.id)).toEqual([completed.file.id]);
  expect((await request(scope, { operation: "download", id: staleId })).status).toBe(400);
  expect((await runtime.dispatchFetch(`http://localhost/alarm?scope=${scope}`, { method: "POST" })).status).toBe(200);
  expect(await bucket.head(prefix + staleId)).toBeNull();
  expect(await bucket.head(prefix + activeId)).not.toBeNull();
  expect(await storage.exec("select id, canceled from file_uploads")).toEqual([{ id: activeId, canceled: 0 }]);
  expect((await list(scope)).files.map(file => file.id)).toEqual([completed.file.id]);
});
