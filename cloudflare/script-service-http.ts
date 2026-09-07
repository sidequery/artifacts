import type { CanvasHttpResponse } from "../src/httpTypes";

/** MCP transport is bounded; direct script URLs retain ordinary streaming HTTP. */
export async function scriptResponse(response: Response, method: string): Promise<CanvasHttpResponse> {
  const reader = response.body?.getReader();
  let binary = "";
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (binary.length + chunk.value.length > 256 * 1024) {
        await reader.cancel();
        throw new Error("Script response body exceeds the MCP limit of 256 KiB; use its URL for larger responses");
      }
      for (let i = 0; i < chunk.value.length; i += 8192) binary += String.fromCharCode(...chunk.value.subarray(i, i + 8192));
    }
  } finally { reader?.releaseLock(); }
  return { status: response.status, statusText: response.statusText, headers: [...response.headers],
    ...([204, 205, 304].includes(response.status) || method === "HEAD" ? {} : { body: btoa(binary) }),
  };
}
