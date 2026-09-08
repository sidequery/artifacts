export type ArtifactFile = { id: string; name: string; size: number; type: string; uploaded: string };
export type ArtifactFileRequest =
  | { operation: "list"; cursor?: string }
  | { operation: "upload"; name: string; size: number; type: string }
  | { operation: "download"; id: string }
  | { operation: "delete"; id: string };
export type ArtifactFileList = { files: ArtifactFile[]; cursor?: string };
export type ArtifactFileTransfer = { file: ArtifactFile; url: string; expires: string };
export type ArtifactFileResult = ArtifactFileList | ArtifactFileTransfer | { deleted: true };
export const MAX_ARTIFACTS_FILE_BYTES = 25 * 1024 * 1024;

type FileBridge = {
  onFileRequest?: (request: ArtifactFileRequest) => Promise<unknown>;
  onFileDownload?: (url: string) => Promise<void>;
};
function bridge(): FileBridge {
  return (globalThis as typeof globalThis & { __artifacts?: FileBridge }).__artifacts ?? {};
}

/** Accept only the dedicated grant endpoint, never arbitrary navigation or redirects. */
export function artifactFileTransferUrl(value: string, origin?: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (origin !== undefined && url.origin !== origin)
    || !/^\/api\/(?:artifact|canvas)\/files\/transfer\/[a-f0-9]{64}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname)) {
    throw new TypeError("Invalid artifact file transfer URL");
  }
  return url.href;
}

async function request<T>(host: FileBridge, value: ArtifactFileRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!host.onFileRequest) throw new Error("Artifact files are unavailable in this view.");
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

export const artifactFiles = {
  async list(options?: { cursor?: string }): Promise<ArtifactFileList> {
    return request(bridge(), { operation: "list", ...options });
  },
  async upload(file: File | Blob, options?: { name?: string; signal?: AbortSignal }): Promise<ArtifactFile> {
    options?.signal?.throwIfAborted();
    if (!(file instanceof Blob)) throw new TypeError("artifactFiles.upload requires a File or Blob");
    if (file.size > MAX_ARTIFACTS_FILE_BYTES) throw new TypeError(`Artifact file exceeds ${MAX_ARTIFACTS_FILE_BYTES} bytes`);
    const name = options?.name ?? (typeof File !== "undefined" && file instanceof File ? file.name : "file");
    const grant = await request<ArtifactFileTransfer>(bridge(), { operation: "upload", name, size: file.size, type: file.type || "application/octet-stream" }, options?.signal);
    options?.signal?.throwIfAborted();
    const init: RequestInit & { credentials: "omit" } = {
      method: "PUT", body: file, credentials: "omit", redirect: "error", signal: options?.signal,
      headers: { "content-type": file.type || "application/octet-stream" },
    };
    const response = await fetch(artifactFileTransferUrl(grant.url), init);
    if (!response.ok) throw new Error(`Artifact file upload failed (${response.status})`);
    const result = await response.json() as { file: ArtifactFile };
    return result.file;
  },
  async read(id: string, options?: { signal?: AbortSignal }): Promise<Blob> {
    const grant = await request<ArtifactFileTransfer>(bridge(), { operation: "download", id }, options?.signal);
    options?.signal?.throwIfAborted();
    const init: RequestInit & { credentials: "omit" } = { credentials: "omit", redirect: "error", signal: options?.signal };
    const response = await fetch(artifactFileTransferUrl(grant.url), init);
    if (!response.ok) throw new Error(`Artifact file read failed (${response.status})`);
    return response.blob();
  },
  async download(id: string): Promise<void> {
    const host = bridge();
    if (!host.onFileDownload) throw new Error("Artifact file downloads are unavailable in this view.");
    const grant = await request<ArtifactFileTransfer>(host, { operation: "download", id });
    await host.onFileDownload(artifactFileTransferUrl(grant.url));
  },
  async delete(id: string): Promise<{ deleted: true }> {
    return request(bridge(), { operation: "delete", id });
  },
};
