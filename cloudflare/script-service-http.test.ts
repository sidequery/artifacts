import { expect, test } from "bun:test";
import { scriptResponse } from "./script-service-http";

test("MCP script responses preserve status, headers, and binary bytes", async () => {
  const bytes = new Uint8Array([0, 255, 13, 10, 128]);
  const result = await scriptResponse(new Response(bytes, { status: 202, headers: { "x-handler": "accepted", "content-type": "application/octet-stream" } }), "POST");
  expect(result.status).toBe(202);
  expect(result.headers).toContainEqual(["x-handler", "accepted"]);
  expect(Uint8Array.from(atob(result.body!), character => character.charCodeAt(0))).toEqual(bytes);
});

test("MCP script response limits cancel streaming bodies before accumulating oversized output", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  });
  await expect(scriptResponse(new Response(stream), "GET")).rejects.toThrow("MCP limit of 256 KiB");
  expect(cancelled).toBe(true);
});

test("MCP script responses omit bodies for HEAD and bodyless status codes", async () => {
  expect(await scriptResponse(new Response(null, { status: 204 }), "POST")).not.toHaveProperty("body");
  expect(await scriptResponse(new Response(null), "HEAD")).not.toHaveProperty("body");
});
