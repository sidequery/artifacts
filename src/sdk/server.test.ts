import { afterEach, expect, test } from "bun:test";

import { canvasFetch, type CanvasHttpRequest, type CanvasHttpResponse } from "./server";

const testGlobal = globalThis as typeof globalThis & { __herdrCanvas?: { onRequest?: (request: CanvasHttpRequest) => Promise<CanvasHttpResponse> } };
const originalBridge = testGlobal.__herdrCanvas;

afterEach(() => {
  if (originalBridge === undefined) delete testGlobal.__herdrCanvas;
  else testGlobal.__herdrCanvas = originalBridge;
});

function installBridge(handler?: (request: CanvasHttpRequest) => Promise<CanvasHttpResponse>) {
  testGlobal.__herdrCanvas = handler ? { onRequest: handler } : {};
}

function encoded(value: string): string {
  return btoa(value);
}

test("canvasFetch preserves native request and response semantics through the JSON envelope", async () => {
  let captured: CanvasHttpRequest | undefined;
  installBridge(async request => {
    captured = request;
    return {
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"], ["x-canvas", "yes"]],
      body: encoded('{"saved":true}'),
    };
  });
  const response = await canvasFetch("/api/items?limit=2#ignored", {
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
  expect(response.headers.get("x-canvas")).toBe("yes");
  expect(await response.json()).toEqual({ saved: true });
});

test("canvasFetch lets Request serialize FormData and enforces the request body limit", async () => {
  const requests: CanvasHttpRequest[] = [];
  installBridge(async request => {
    requests.push(request);
    return { status: 200, statusText: "OK", headers: [], body: encoded("ok") };
  });
  const form = new FormData();
  form.set("name", "native form");
  expect(await (await canvasFetch("/form", { method: "POST", body: form })).text()).toBe("ok");
  expect(new Headers(requests[0]!.headers).get("content-type")?.startsWith("multipart/form-data; boundary=")).toBe(true);
  expect(atob(requests[0]!.body!)).toContain("native form");

  await canvasFetch("/limit", { method: "POST", body: "x".repeat(256 * 1024) });
  expect(requests).toHaveLength(2);
  await expect(canvasFetch("/too-large", { method: "POST", body: "x".repeat(256 * 1024 + 1) })).rejects.toThrow("exceeds 262144 bytes");
  expect(requests).toHaveLength(2);
});

test("canvasFetch returns null bodies for HEAD and bodyless response statuses", async () => {
  installBridge(async request => ({
    status: request.path === "/head" ? 200 : Number(request.path.slice(1)),
    statusText: "Bodyless",
    headers: [["x-body", "ignored"]],
    body: encoded("must not become a response body"),
  }));
  const head = await canvasFetch("/head", { method: "HEAD" });
  expect(head.body).toBeNull();
  expect(await head.text()).toBe("");
  for (const status of [204, 205, 304]) {
    const response = await canvasFetch(`/${status}`);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  }
});

test("canvasFetch rejects unavailable, unsafe, and aborted requests before delivery", async () => {
  installBridge();
  await expect(canvasFetch("/missing")).rejects.toThrow("Canvas server requests are unavailable in this view");

  let calls = 0;
  installBridge(async () => {
    calls += 1;
    return { status: 200, statusText: "OK", headers: [] };
  });
  for (const url of ["//evil.example/path", "https://evil.example/path", "https://canvas.invalid/path", "file:///tmp/data", "mailto:test@example.com"]) {
    await expect(canvasFetch(url)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(canvasFetch("/aborted", { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(0);
});
