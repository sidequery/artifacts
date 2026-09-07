import { expect, test } from "bun:test";
import { canvasApiRequest, canvasApiResponse } from "./canvas-api";

test("direct API envelopes preserve binary bodies, query strings and public application credentials", async () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 13]);
  const input = await canvasApiRequest(new Request("https://canvas.example/demo/api/items?a=1&a=%FF", {
    method: "PATCH", body: bytes,
    headers: { cookie: "session=private", "cf-access-jwt-assertion": "jwt", "cf-access-client-id": "id", "cf-access-client-secret": "secret", authorization: "Bearer app-token", "x-input": "kept" },
  }), "/demo", false);
  expect(input.path).toBe("/api/items?a=1&a=%FF");
  expect(input.method).toBe("PATCH");
  expect(Uint8Array.from(atob(input.body!), char => char.charCodeAt(0))).toEqual(bytes);
  const headers = new Headers(input.headers);
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) expect(headers.has(name)).toBe(false);
  expect(headers.get("authorization")).toBe("Bearer app-token");
  expect(headers.get("x-input")).toBe("kept");
  const response = canvasApiResponse({ status: 201, statusText: "Created", headers: [["x-output", "kept"], ["set-cookie", "session=forged"], ["content-type", "application/octet-stream"]], body: input.body }, "PATCH");
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("x-output")).toBe("kept");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
});

test("private API requests remove authorization and GET/HEAD requests have no body", async () => {
  for (const method of ["GET", "HEAD"]) {
    const input = await canvasApiRequest(new Request("https://canvas.example/demo/api", { method, headers: { authorization: "Bearer management" } }), "/demo", true);
    expect(input.path).toBe("/api");
    expect(input.body).toBeUndefined();
    expect(new Headers(input.headers).has("authorization")).toBe(false);
  }
});

test("direct API requests enforce the 256 KiB byte boundary", async () => {
  const atLimit = await canvasApiRequest(new Request("https://canvas.example/demo/api", { method: "POST", body: new Uint8Array(256 * 1024) }), "/demo", false);
  expect(atob(atLimit.body!).length).toBe(256 * 1024);
  await expect(canvasApiRequest(new Request("https://canvas.example/demo/api", { method: "POST", body: new Uint8Array(256 * 1024 + 1) }), "/demo", false)).rejects.toThrow("256 KiB");
});

test("API responses preserve not-found status, sandbox HTML and suppress bodyless payloads", async () => {
  const response = canvasApiResponse({ status: 404, statusText: "Not Found", headers: [["content-type", "text/html"], ["content-security-policy", "default-src 'self'"]], body: btoa("<h1>Missing</h1>") }, "GET");
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("<h1>Missing</h1>");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
  for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 205], ["GET", 304]] as const) {
    expect(canvasApiResponse({ status, statusText: "", headers: [], body: btoa("ignored") }, method).body).toBeNull();
  }
  expect(() => canvasApiResponse({ status: 200, statusText: "OK", headers: [], body: btoa("x".repeat(256 * 1024 + 1)) }, "GET")).toThrow("256 KiB");
});
