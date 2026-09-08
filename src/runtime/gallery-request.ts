import type { HostBridge } from "../sdk/hooks";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "../sdk/server";

const bridge = (window as Window & { __artifacts?: HostBridge & { serverVersionId?: string; filesVersionId?: string; plugins?: boolean } }).__artifacts;
if (bridge?.serverVersionId && window.parent !== window) {
  const pending = new Map<string, { resolve: (value: ArtifactHttpResponse) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "artifact/http-response") return;
    const item = pending.get(event.data.id);
    if (!item) return;
    clearTimeout(item.timeout);
    pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(String(event.data.error)));
    else item.resolve(event.data.response);
  });
  bridge.onRequest = (request: ArtifactHttpRequest) => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Too many pending artifact requests"));
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Artifact server request timed out"));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ type: "artifact/http-request", id, versionId: bridge.serverVersionId, request }, "*");
  });
}

if (bridge?.plugins && window.parent !== window) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "artifact/plugin-response") return;
    const item = pending.get(event.data.id);
    if (!item) return;
    clearTimeout(item.timeout);
    pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(String(event.data.error)));
    else item.resolve(event.data.result);
  });
  bridge.onPluginCall = request => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Too many pending plugin calls"));
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Plugin call timed out")); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ type: "artifact/plugin-request", id, request }, "*");
  });
}

if (bridge?.filesVersionId && window.parent !== window) {
  const pending = new Map<string, { responseType: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const item = pending.get(event.data?.id);
    if (!item || event.data?.type !== item.responseType) return;
    clearTimeout(item.timeout);
    pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(String(event.data.error)));
    else item.resolve(event.data.result);
  });
  const send = (type: string, responseType: string, value: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Too many pending artifact file requests"));
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Artifact file request timed out")); }, 30000);
    pending.set(id, { responseType, resolve, reject, timeout });
    window.parent.postMessage({ type, id, versionId: bridge.filesVersionId, ...value }, "*");
  });
  bridge.onFileRequest = request => send("artifact/files-request", "artifact/files-response", { request });
  bridge.onFileDownload = async url => { await send("artifact/file-download", "artifact/file-download-response", { url }); };
}
