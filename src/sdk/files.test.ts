import { afterEach, expect, test } from "bun:test";
import { artifactFiles, artifactFileTransferUrl, MAX_ARTIFACTS_FILE_BYTES, type ArtifactFileRequest } from "./files";
import type { HostBridge } from "./hooks";

const host = globalThis as typeof globalThis & { __artifacts?: HostBridge };
const original = host.__artifacts;
const originalFetch = globalThis.fetch;
const url = `https://artifact.example/api/artifact/files/transfer/${"a".repeat(64)}/12345678-1234-1234-1234-123456789abc`;
const file = { id: "one", name: "binary.bin", size: 300_000, type: "application/octet-stream", uploaded: "2026-09-07T00:00:00Z" };
const grant = { file, url, expires: "2026-09-07T00:05:00Z" };
afterEach(() => { host.__artifacts = original; globalThis.fetch = originalFetch; });

function mockFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

test("uploads binary blobs above the server envelope limit directly with no credentials", async () => {
  const requests: ArtifactFileRequest[] = [];
  host.__artifacts = { onFileRequest: async request => { requests.push(request); return grant; } };
  const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => i % 256);
  const body = new File([bytes], "binary.bin", { type: "application/octet-stream" });
  mockFetch(async (input, init) => {
    expect(input).toBe(url);
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBe(body);
    expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(bytes);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return Response.json({ file: { ...file, uploaded: "2026-09-07T00:00:01Z" } }, { status: 201 });
  });
  expect(await artifactFiles.upload(body)).toEqual({ ...file, uploaded: "2026-09-07T00:00:01Z" });
  expect(requests).toEqual([{ operation: "upload", name: "binary.bin", size: 300_000, type: "application/octet-stream" }]);
});

test("lists pages, reads binary data, delegates downloads and deletes using metadata only", async () => {
  const requests: ArtifactFileRequest[] = [];
  const downloads: string[] = [];
  host.__artifacts = {
    onFileRequest: async request => {
      requests.push(request);
      return request.operation === "list" ? { files: [file], cursor: "next" } : request.operation === "delete" ? { deleted: true } : grant;
    },
    onFileDownload: async url => { downloads.push(url); },
  };
  const bytes = new Uint8Array([0, 255, 128, 1]);
  mockFetch(async (input, init) => {
    expect(input).toBe(url);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    return new Response(bytes);
  });
  expect(await artifactFiles.list({ cursor: "page" })).toEqual({ files: [file], cursor: "next" });
  expect(new Uint8Array(await (await artifactFiles.read("one")).arrayBuffer())).toEqual(bytes);
  await artifactFiles.download("one");
  expect(downloads).toEqual([url]);
  expect(await artifactFiles.delete("one")).toEqual({ deleted: true });
  expect(requests).toEqual([{ operation: "list", cursor: "page" }, { operation: "download", id: "one" }, { operation: "download", id: "one" }, { operation: "delete", id: "one" }]);
});

test("rejects unavailable, oversized and failed transfers", async () => {
  host.__artifacts = {};
  await expect(artifactFiles.list()).rejects.toThrow("unavailable");
  await expect(artifactFiles.upload(new Blob([new Uint8Array(MAX_ARTIFACTS_FILE_BYTES + 1)]))).rejects.toThrow("exceeds");
  host.__artifacts = { onFileRequest: async () => { throw new Error("denied"); } };
  await expect(artifactFiles.read("one")).rejects.toThrow("denied");
  host.__artifacts = { onFileRequest: async () => grant };
  mockFetch(async () => new Response(null, { status: 410 }));
  await expect(artifactFiles.upload(new Blob(["x"]))).rejects.toThrow("upload failed (410)");
  await expect(artifactFiles.read("one")).rejects.toThrow("read failed (410)");
  host.__artifacts.onFileDownload = async () => { throw new Error("host declined"); };
  await expect(artifactFiles.download("one")).rejects.toThrow("host declined");
});

test("validates grant URLs and prevents transfers after cancellation", async () => {
  for (const invalid of ["javascript:alert(1)", "https://evil.example/", `${url}?redirect=x`, `${url}#fragment`, url.replace("https://", "https://user:pass@")]) {
    expect(() => artifactFileTransferUrl(invalid)).toThrow();
  }
  expect(() => artifactFileTransferUrl(url, "https://other.example")).toThrow();
  let calls = 0;
  let fetches = 0;
  mockFetch(async () => { fetches++; return new Response(); });
  const controller = new AbortController();
  host.__artifacts = { onFileRequest: async () => { calls++; controller.abort(); return grant; } };
  await expect(artifactFiles.upload(new Blob(["x"]), { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(1);
  expect(fetches).toBe(0);
  await expect(artifactFiles.read("one", { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(1);
  host.__artifacts.onFileRequest = async () => ({ ...grant, url: "https://evil.example/" });
  await expect(artifactFiles.read("one")).rejects.toThrow("Invalid artifact file transfer URL");
  expect(fetches).toBe(0);
});

test("cancellation rejects while a metadata request is still pending", async () => {
  host.__artifacts = { onFileRequest: () => new Promise(() => {}) };
  const controller = new AbortController();
  const read = artifactFiles.read("one", { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error("stopped"));
  await expect(read).rejects.toThrow("stopped");
});


test("legacy grant endpoints retain validation and work for binary reads and host downloads", async () => {
  const legacyUrl = url.replace("/api/artifact/", "/api/canvas/");
  expect(artifactFileTransferUrl(legacyUrl, "https://artifact.example")).toBe(legacyUrl);
  for (const invalid of [legacyUrl + "?redirect=x", legacyUrl + "#fragment", legacyUrl.replace("https://", "https://user@"), legacyUrl.replace("/transfer/", "/other/")]) {
    expect(() => artifactFileTransferUrl(invalid)).toThrow();
  }
  expect(() => artifactFileTransferUrl(legacyUrl, "https://other.example")).toThrow();
  const downloads: string[] = [];
  host.__artifacts = { onFileRequest: async () => ({ ...grant, url: legacyUrl }), onFileDownload: async value => { downloads.push(value); } };
  mockFetch(async (input, init) => { expect(input).toBe(legacyUrl); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error"); return new Response("legacy bytes"); });
  expect(await (await artifactFiles.read("one")).text()).toBe("legacy bytes");
  await artifactFiles.download("one");
  expect(downloads).toEqual([legacyUrl]);
});
