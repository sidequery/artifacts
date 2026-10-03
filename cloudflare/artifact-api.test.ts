import { expect, test } from "bun:test";
import { artifactApiRequest, artifactApiResponse } from "./artifact-api";

test("direct API requests preserve native bodies, origins, queries and public application credentials", async () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 13]);
  const input = artifactApiRequest(new Request("https://artifact.example/demo/api/items?a=1&a=%FF", {
    method: "PATCH", body: bytes,
    headers: { cookie: "session=private", "cf-access-jwt-assertion": "jwt", "cf-access-client-id": "id", "cf-access-client-secret": "secret", authorization: "Bearer app-token", "x-input": "kept" },
  }), "/demo", false);
  expect(input.url).toBe("https://artifact.example/api/items?a=1&a=%FF");
  expect(input.method).toBe("PATCH");
  expect(new Uint8Array(await input.arrayBuffer())).toEqual(bytes);
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) expect(input.headers.has(name)).toBe(false);
  expect(input.headers.get("authorization")).toBe("Bearer app-token");
  expect(input.headers.get("x-input")).toBe("kept");
  const response = artifactApiResponse(new Response(bytes, { status: 201, statusText: "Created", headers: { "x-output": "kept", "set-cookie": "session=forged", "content-type": "application/octet-stream" } }), "PATCH");
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("x-output")).toBe("kept");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
});

test("private API requests strip authorization and preserve bodyless GET/HEAD", () => {
  for (const method of ["GET", "HEAD"]) {
    const input = artifactApiRequest(new Request("https://artifact.example/demo/api", { method, headers: { authorization: "Bearer management" } }), "/demo", true);
    expect(new URL(input.url).pathname).toBe("/api");
    expect(input.body).toBeNull();
    expect(input.headers.has("authorization")).toBe(false);
  }
});

test("direct API bodies stream past the browser/MCP envelope boundary", async () => {
  const bytes = new Uint8Array(512 * 1024).fill(42);
  const input = artifactApiRequest(new Request("https://artifact.example/demo/api", { method: "POST", body: bytes }), "/demo", false);
  expect(new Uint8Array(await input.arrayBuffer())).toEqual(bytes);
  let finish!: () => void;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes);
    finish = () => { controller.enqueue(new Uint8Array([7])); controller.close(); };
  } });
  const response = artifactApiResponse(new Response(stream), "GET");
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(bytes);
  finish();
  expect((await reader.read()).value).toEqual(new Uint8Array([7]));
  expect((await reader.read()).done).toBe(true);
});

test("API responses preserve not-found, sandbox HTML and suppress HEAD payloads", async () => {
  const response = artifactApiResponse(new Response("<h1>Missing</h1>", { status: 404, headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" } }), "GET");
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("<h1>Missing</h1>");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
  expect(artifactApiResponse(new Response("ignored"), "HEAD").body).toBeNull();
  for (const status of [204, 205, 304]) expect(artifactApiResponse(new Response(null, { status }), "GET").body).toBeNull();
});
