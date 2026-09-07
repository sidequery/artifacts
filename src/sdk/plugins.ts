import type { PluginRequest } from "../plugins/types";
export type { PluginRequest } from "../plugins/types";

/** Used by installed browser libraries to implement their typed API clients. */
export async function pluginCall<T>(plugin: string, operation: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
  options.signal?.throwIfAborted();
  if (typeof plugin !== "string" || !plugin || plugin.length > 214 || typeof operation !== "string" || !operation || operation.length > 64 || input === undefined) {
    throw new TypeError("pluginCall requires a plugin, operation and JSON input");
  }
  const encoded = JSON.stringify({ plugin, operation, input });
  if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) throw new RangeError("Plugin input exceeds 256 KiB");
  const bridge = (globalThis as typeof globalThis & { __herdrCanvas?: { onPluginCall?: (request: PluginRequest) => Promise<unknown> } }).__herdrCanvas;
  if (!bridge?.onPluginCall) throw new Error("Plugin functions are unavailable in this view");
  const request: PluginRequest = JSON.parse(encoded);
  return new Promise<T>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { finish(); reject(new Error("Plugin call timed out")); }, 30000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => bridge.onPluginCall!(request)).then(value => {
      finish(); resolve(value as T);
    }, error => { finish(); reject(error); });
  });
}
