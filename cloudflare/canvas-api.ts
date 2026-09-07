import type { CanvasHttpRequest, CanvasHttpResponse } from "../src/httpTypes";

const MAX_BODY = 256 * 1024;

/** Adapt a standalone API request to the same bounded envelope used by the SDK. */
export async function canvasApiRequest(request: Request, basePath: string, privateLink: boolean): Promise<CanvasHttpRequest> {
  const headers = new Headers(request.headers);
  for (const name of ["cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) headers.delete(name);
  if (privateLink) headers.delete("authorization");
  const url = new URL(request.url);
  const reader = request.body?.getReader();
  let binary = "";
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (binary.length + chunk.value.byteLength > MAX_BODY) {
        await reader.cancel();
        throw new RangeError("Canvas request body exceeds 256 KiB");
      }
      for (let i = 0; i < chunk.value.length; i += 8192) binary += String.fromCharCode(...chunk.value.subarray(i, i + 8192));
    }
  } finally { reader?.releaseLock(); }
  return { path: url.pathname.slice(basePath.length) + url.search, method: request.method, headers: [...headers], ...(reader ? { body: btoa(binary) } : {}) };
}

export function canvasApiResponse(input: Omit<CanvasHttpResponse, "headers"> & { headers: string[][] }, method: string): Response {
  // Durable Object RPC widens tuple arrays to string[][] on the caller side.
  const headers = new Headers(input.headers as [string, string][]);
  headers.delete("set-cookie");
  headers.append("content-security-policy", "sandbox allow-scripts allow-forms");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "private, no-store");
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (input.body !== undefined && method !== "HEAD" && ![204, 205, 304].includes(input.status)) {
    if (input.body.length > Math.ceil(MAX_BODY / 3) * 4) throw new RangeError("Canvas response body exceeds 256 KiB");
    const binary = atob(input.body);
    if (binary.length > MAX_BODY) throw new RangeError("Canvas response body exceeds 256 KiB");
    body = Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  return new Response(body, { status: input.status, statusText: input.statusText, headers });
}
