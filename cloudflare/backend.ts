import { DurableObject } from "cloudflare:workers";
import type { CanvasHttpRequest, CanvasHttpResponse } from "../src/httpTypes";

export type BackendEnv = { LOADER: WorkerLoader };
const MAX_BODY = 256 * 1024;

function decode(body: string): Uint8Array {
  if (body.length > Math.ceil(MAX_BODY / 3) * 4) throw new Error("Canvas request body exceeds 256 KiB");
  const binary = atob(body);
  if (binary.length > MAX_BODY) throw new Error("Canvas request body exceeds 256 KiB");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function nativeRequest(input: CanvasHttpRequest): Request {
  if (typeof input.path !== "string" || input.path.length > 8192 || !input.path.startsWith("/")) throw new Error("Canvas request path must start with /");
  const url = new URL(input.path, "https://canvas.invalid");
  if (url.origin !== "https://canvas.invalid") throw new Error("Canvas requests cannot select another origin");
  return new Request(url, { method: input.method, headers: input.headers,
    ...(input.body === undefined ? {} : { body: decode(input.body) }),
  });
}

async function serializeResponse(response: Response, method: string): Promise<CanvasHttpResponse> {
  const reader = response.body?.getReader();
  let binary = "";
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (binary.length + chunk.value.length > MAX_BODY) {
        await reader.cancel();
        throw new Error("Canvas response body exceeds 256 KiB");
      }
      for (let i = 0; i < chunk.value.length; i += 8192) binary += String.fromCharCode(...chunk.value.subarray(i, i + 8192));
    }
  } finally { reader?.releaseLock(); }
  return { status: response.status, statusText: response.statusText, headers: [...response.headers],
    ...([204, 205, 304].includes(response.status) || method === "HEAD" ? {} : { body: btoa(binary) }),
  };
}

/** One supervisor per authorized library/workspace/canvas. The user-authored
 * class runs in a separate isolate and owns its own native SQLite database. */
export class CanvasBackend extends DurableObject<BackendEnv> {
  private activeCode: string | undefined;

  async request(input: { code: string; hash: string; request: CanvasHttpRequest }): Promise<CanvasHttpResponse> {
    const request = nativeRequest(input.request);
    if (this.activeCode !== input.hash) {
      // Reload code while preserving the facet's database. Never delete/reset
      // storage as a side effect of an edit, preview, or source restoration.
      this.ctx.facets.abort("canvas", "Canvas server code updated");
      this.activeCode = input.hash;
    }
    const facet = this.ctx.facets.get("canvas", () => {
      const worker = this.env.LOADER.get(input.hash, async () => ({
        compatibilityDate: "2026-09-06",
        mainModule: "canvas-server.js",
        modules: { "canvas-server.js": input.code },
        globalOutbound: null,
      }));
      return { class: worker.getDurableObjectClass("CanvasServer") };
    });
    return serializeResponse(await facet.fetch(request), request.method);
  }
}
