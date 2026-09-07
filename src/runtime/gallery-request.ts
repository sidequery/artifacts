import type { HostBridge } from "../sdk/hooks";
import type { CanvasHttpRequest, CanvasHttpResponse } from "../sdk/server";

const bridge = (window as Window & { __herdrCanvas?: HostBridge & { serverVersionId?: string; plugins?: boolean } }).__herdrCanvas;
if (bridge?.serverVersionId && window.parent !== window) {
  const pending = new Map<string, { resolve: (value: CanvasHttpResponse) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "canvas/http-response") return;
    const item = pending.get(event.data.id);
    if (!item) return;
    clearTimeout(item.timeout);
    pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(String(event.data.error)));
    else item.resolve(event.data.response);
  });
  bridge.onRequest = (request: CanvasHttpRequest) => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error("Too many pending canvas requests"));
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Canvas server request timed out"));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ type: "canvas/http-request", id, versionId: bridge.serverVersionId, request }, "*");
  });
}

if (bridge?.plugins && window.parent !== window) {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "canvas/plugin-response") return;
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
    window.parent.postMessage({ type: "canvas/plugin-request", id, request }, "*");
  });
}
