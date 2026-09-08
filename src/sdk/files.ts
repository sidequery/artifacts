export type CanvasFile = { id: string; name: string; size: number; type: string; uploaded: string };
export type CanvasFileRequest =
  | { operation: "list"; cursor?: string }
  | { operation: "upload"; name: string; size: number; type: string }
  | { operation: "download"; id: string }
  | { operation: "delete"; id: string };
export type CanvasFileList = { files: CanvasFile[]; cursor?: string };
export type CanvasFileTransfer = { file: CanvasFile; url: string; expires: string };
export type CanvasFileResult = CanvasFileList | CanvasFileTransfer | { deleted: true };
export const MAX_CANVAS_FILE_BYTES = 25 * 1024 * 1024;

type FileBridge = {
  onFileRequest?: (request: CanvasFileRequest) => Promise<unknown>;
  onFileDownload?: (url: string) => Promise<void>;
};
function bridge(): FileBridge {
  return (globalThis as typeof globalThis & { __herdrCanvas?: FileBridge }).__herdrCanvas ?? {};
}

/** Accept only the dedicated grant endpoint, never arbitrary navigation or redirects. */
export function canvasFileTransferUrl(value: string, origin?: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (origin !== undefined && url.origin !== origin)
    || !/^\/api\/canvas\/files\/transfer\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname)) {
    throw new TypeError("Invalid canvas file transfer URL");
  }
  return url.href;
}

async function request<T>(host: FileBridge, value: CanvasFileRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!host.onFileRequest) throw new Error("Canvas files are unavailable in this view.");
  if (!signal) return await host.onFileRequest(value) as T;
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return host.onFileRequest!(value);
    }).then(value => resolve(value as T), reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export const canvasFiles = {
  async list(options?: { cursor?: string }): Promise<CanvasFileList> {
    return request(bridge(), { operation: "list", ...options });
  },
  async upload(file: File | Blob, options?: { name?: string; signal?: AbortSignal }): Promise<CanvasFile> {
    options?.signal?.throwIfAborted();
    if (!(file instanceof Blob)) throw new TypeError("canvasFiles.upload requires a File or Blob");
    if (file.size > MAX_CANVAS_FILE_BYTES) throw new TypeError(`Canvas file exceeds ${MAX_CANVAS_FILE_BYTES} bytes`);
    const name = options?.name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "file");
    const grant = await request<CanvasFileTransfer>(bridge(), { operation: "upload", name, size: file.size, type: file.type || "application/octet-stream" }, options?.signal);
    options?.signal?.throwIfAborted();
    const init: RequestInit & { credentials: "omit" } = {
      method: "PUT", body: file, credentials: "omit", redirect: "error", signal: options?.signal,
      headers: { "content-type": file.type || "application/octet-stream" },
    };
    const response = await fetch(canvasFileTransferUrl(grant.url), init);
    if (!response.ok) throw new Error(`Canvas file upload failed (${response.status})`);
    const result = await response.json() as { file: CanvasFile };
    return result.file;
  },
  async read(id: string, options?: { signal?: AbortSignal }): Promise<Blob> {
    const grant = await request<CanvasFileTransfer>(bridge(), { operation: "download", id }, options?.signal);
    options?.signal?.throwIfAborted();
    const init: RequestInit & { credentials: "omit" } = { credentials: "omit", redirect: "error", signal: options?.signal };
    const response = await fetch(canvasFileTransferUrl(grant.url), init);
    if (!response.ok) throw new Error(`Canvas file read failed (${response.status})`);
    return response.blob();
  },
  async download(id: string): Promise<void> {
    const host = bridge();
    if (!host.onFileDownload) throw new Error("Canvas file downloads are unavailable in this view.");
    const grant = await request<CanvasFileTransfer>(host, { operation: "download", id });
    await host.onFileDownload(canvasFileTransferUrl(grant.url));
  },
  async delete(id: string): Promise<{ deleted: true }> {
    return request(bridge(), { operation: "delete", id });
  },
};
