import { afterEach, expect, test } from "bun:test";

import { artifactFetch, type ArtifactHttpRequest, type ArtifactHttpResponse } from "./server";

const testGlobal = globalThis as typeof globalThis & { __artifacts?: { onRequest?: (request: ArtifactHttpRequest) => Promise<ArtifactHttpResponse> } };
const originalBridge = testGlobal.__artifacts;

afterEach(() => {
  if (originalBridge === undefined) delete testGlobal.__artifacts;
  else testGlobal.__artifacts = originalBridge;
});

function installBridge(handler?: (request: ArtifactHttpRequest) => Promise<ArtifactHttpResponse>) {
  testGlobal.__artifacts = handler ? { onRequest: handler } : {};
}

function encoded(value: string): string {
  return btoa(value);
}

test("artifactFetch preserves native request and response semantics through the JSON envelope", async () => {
  let captured: ArtifactHttpRequest | undefined;
  installBridge(async request => {
    captured = request;
    return {
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"], ["x-artifact", "yes"]],
      body: encoded('{"saved":true}'),
    };
  });
  const response = await artifactFetch("/api/items?limit=2#ignored", {
    method: "post",
    headers: { "content-type": "application/json", "x-request": "native" },
    body: JSON.stringify({ title: "hello" }),
  });

  expect(captured?.path).toBe("/api/items?limit=2");
  expect(captured?.method).toBe("POST");
  expect(new Headers(captured?.headers).get("content-type")).toBe("application/json");
  expect(new Headers(captured?.headers).get("x-request")).toBe("native");
  expect(atob(captured!.body!)).toBe('{"title":"hello"}');
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(response.headers.get("x-artifact")).toBe("yes");
  expect(await response.json()).toEqual({ saved: true });
});

test("artifactFetch lets Request serialize FormData and enforces the request body limit", async () => {
  const requests: ArtifactHttpRequest[] = [];
  installBridge(async request => {
    requests.push(request);
    return { status: 200, statusText: "OK", headers: [], body: encoded("ok") };
  });
  const form = new FormData();
  form.set("name", "native form");
  expect(await (await artifactFetch("/form", { method: "POST", body: form })).text()).toBe("ok");
  expect(new Headers(requests[0]!.headers).get("content-type")?.startsWith("multipart/form-data; boundary=")).toBe(true);
  expect(atob(requests[0]!.body!)).toContain("native form");

  await artifactFetch("/limit", { method: "POST", body: "x".repeat(256 * 1024) });
  expect(requests).toHaveLength(2);
  await expect(artifactFetch("/too-large", { method: "POST", body: "x".repeat(256 * 1024 + 1) })).rejects.toThrow("exceeds 262144 bytes");
  expect(requests).toHaveLength(2);
});

test("artifactFetch returns null bodies for HEAD and bodyless response statuses", async () => {
  installBridge(async request => ({
    status: request.path === "/head" ? 200 : Number(request.path.slice(1)),
    statusText: "Bodyless",
    headers: [["x-body", "ignored"]],
    body: encoded("must not become a response body"),
  }));
  const head = await artifactFetch("/head", { method: "HEAD" });
  expect(head.body).toBeNull();
  expect(await head.text()).toBe("");
  for (const status of [204, 205, 304]) {
    const response = await artifactFetch(`/${status}`);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  }
});

test("artifactFetch rejects unavailable, unsafe, and aborted requests before delivery", async () => {
  installBridge();
  await expect(artifactFetch("/missing")).rejects.toThrow("Artifact server requests are unavailable in this view");

  let calls = 0;
  installBridge(async () => {
    calls += 1;
    return { status: 200, statusText: "OK", headers: [] };
  });
  for (const url of ["//evil.example/path", "https://evil.example/path", "https://artifact.invalid/path", "file:///tmp/data", "mailto:test@example.com"]) {
    await expect(artifactFetch(url)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(artifactFetch("/aborted", { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(0);
});
