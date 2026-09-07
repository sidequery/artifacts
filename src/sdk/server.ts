export type { CanvasHttpRequest, CanvasHttpResponse } from "../httpTypes";
import type { CanvasHttpRequest, CanvasHttpResponse } from "../httpTypes";

type RequestBridge = {
  onRequest?: (request: CanvasHttpRequest) => Promise<CanvasHttpResponse>;
};

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const FALLBACK_ORIGIN = "https://canvas.invalid";

function requestBridge(): RequestBridge {
  return (globalThis as typeof globalThis & { __herdrCanvas?: RequestBridge }).__herdrCanvas ?? {};
}

function target(path: string): { url: string; path: string } {
  if (path.startsWith("//")) throw new TypeError("canvasFetch does not allow protocol-relative URLs");
  const currentOrigin = typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")
    ? location.origin
    : undefined;
  const browserOrigin = currentOrigin ?? FALLBACK_ORIGIN;
  let url: URL;
  try {
    url = new URL(path, browserOrigin);
  } catch {
    throw new TypeError("canvasFetch requires a valid HTTP path");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("canvasFetch only supports HTTP paths");
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(path);
  if (absolute && (!currentOrigin || url.origin !== currentOrigin)) throw new TypeError("canvasFetch does not allow cross-origin URLs");
  return { url: url.href, path: `${url.pathname}${url.search}` };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function bridgeRequest(bridge: RequestBridge, envelope: CanvasHttpRequest, signal: AbortSignal): Promise<CanvasHttpResponse> {
  if (!bridge.onRequest) throw new Error("Canvas server requests are unavailable in this view.");
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<CanvasHttpResponse>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    bridge.onRequest!(envelope).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function canvasFetch(path: string, init?: RequestInit): Promise<Response> {
  const resolved = target(path);
  const request = new Request(resolved.url, init);
  // Bun currently clears its generated multipart content-type after consuming
  // a FormData body, so snapshot native header normalization first.
  const headers = Array.from(request.headers.entries()) as [string, string][];
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new TypeError(`canvasFetch request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }
  const envelope: CanvasHttpRequest = {
    path: resolved.path,
    method: request.method,
    headers,
    ...(bytes.byteLength > 0 ? { body: encodeBase64(bytes) } : {}),
  };
  const response = await bridgeRequest(requestBridge(), envelope, request.signal);
  const bodyless = request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodyless || response.body === undefined ? null : decodeBase64(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
