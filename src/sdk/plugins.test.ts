import { afterEach, expect, test } from "bun:test";
import { pluginCall } from "./plugins";
import type { PluginRequest } from "../plugins/types";
const host = globalThis as typeof globalThis & { __herdrCanvas?: { onPluginCall?: (request: PluginRequest) => Promise<unknown> } };
const original = host.__herdrCanvas;
afterEach(() => { if (original === undefined) delete host.__herdrCanvas; else host.__herdrCanvas = original; });

test("pluginCall delivers JSON and returns the typed server result", async () => {
  let received: PluginRequest | undefined;
  const input = { id: "record-1" };
  host.__herdrCanvas = { onPluginCall: async request => { received = request; return { name: "Record" }; } };
  expect(await pluginCall<{ name: string }>("directory", "lookup", input)).toEqual({ name: "Record" });
  expect(received).toEqual({ plugin: "directory", operation: "lookup", input });
  expect(received!.input).not.toBe(input);
});

test("pluginCall rejects invalid, oversized and unavailable calls", async () => {
  host.__herdrCanvas = {};
  await expect(pluginCall("directory", "lookup", {})).rejects.toThrow("unavailable");
  let calls = 0;
  host.__herdrCanvas = { onPluginCall: async () => { calls++; return null; } };
  await expect(pluginCall("", "lookup", {})).rejects.toThrow(TypeError);
  await expect(pluginCall("directory", "lookup", undefined)).rejects.toThrow(TypeError);
  await expect(pluginCall("directory", "lookup", "x".repeat(256 * 1024))).rejects.toThrow(RangeError);
  const controller = new AbortController(); controller.abort();
  await expect(pluginCall("directory", "lookup", {}, { signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("pluginCall propagates server errors and client cancellation", async () => {
  host.__herdrCanvas = { onPluginCall: async () => { throw new Error("Operation denied"); } };
  await expect(pluginCall("directory", "lookup", {})).rejects.toThrow("Operation denied");
  host.__herdrCanvas = { onPluginCall: () => new Promise(() => {}) };
  const controller = new AbortController();
  const pending = pluginCall("directory", "lookup", {}, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow();
});
