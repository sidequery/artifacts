import type { HostBridge } from "../sdk/hooks";

type PreviewContext = Pick<HostBridge, "artifactId" | "state" | "route" | "theme" | "actions" | "environment" | "modelContext" | "contextAttached">;
type PreviewMethod = "onAction" | "onRequest" | "onPluginCall" | "onFileRequest" | "onFileDownload" | "onModelContext";

// This function is serialized into the opaque preview document. Keep it
// self-contained: only scoped bridge operations cross the frame boundary.
function previewBootstrap(initial: PreviewContext, methods: PreviewMethod[]) {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  const bridge: HostBridge = { ...initial };
  let state = initial.state;
  Object.defineProperty(bridge, "state", { get: () => state, set(value) {
    state = value;
    parent.postMessage({ type: "artifacts/preview-state", state: value }, "*");
  } });
  const call = (method: PreviewMethod, value: unknown) => new Promise<unknown>((resolve, reject) => {
    if (pending.size >= 32) { reject(new Error("Too many pending artifact requests")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Artifact request timed out")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: "artifacts/preview-call", id, method, value }, "*");
  });
  for (const method of methods) {
    Object.assign(bridge, { [method]: (value: unknown) => call(method, value) });
  }
  Object.assign(window, { __artifacts: bridge, __herdrCanvas: bridge });
  addEventListener("message", event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data?.type === "artifacts/preview-context") {
      Object.assign(bridge, data.context);
      dispatchEvent(new Event("artifact-host-context-change"));
      dispatchEvent(new Event("artifact-theme-change"));
      return;
    }
    if (data?.type !== "artifacts/preview-result") return;
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  addEventListener("artifact/navigate", event => {
    const { path } = (event as CustomEvent<{ path: string }>).detail;
    if (bridge.route) bridge.route.path = path;
    parent.postMessage({ type: "artifacts/preview-route", path }, "*");
  });
  const report = (message: string) => parent.postMessage({ type: "artifacts/preview-error", message }, "*");
  window.addEventListener("error", event => report(event.message));
  window.addEventListener("unhandledrejection", event => report(String(event.reason)));
}

/** Isolate authored CSS and its #root from the shared gallery React tree. */
export function mountMcpPreview(container: HTMLElement, javascript: string, bridge: HostBridge, onError: (message: string) => void) {
  const frame = document.createElement("iframe");
  frame.className = "preview-frame";
  frame.title = `Preview of ${bridge.artifactId ?? "artifact"}`;
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  const methods = (["onAction", "onRequest", "onPluginCall", "onFileRequest", "onFileDownload", "onModelContext"] as const).filter(method => typeof bridge[method] === "function");
  const context = (): PreviewContext => ({ artifactId: bridge.artifactId, state: bridge.state, route: bridge.route, theme: bridge.theme, actions: bridge.actions, environment: bridge.environment, modelContext: bridge.modelContext, contextAttached: bridge.contextAttached });
  const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}body{box-sizing:border-box}#root{min-width:0}</style></head><body><div id="root"></div><script>(${previewBootstrap.toString()})(${json(context())},${json(methods)})</script><script type="module">${javascript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  let disposed = false;
  const receive = async (event: MessageEvent) => {
    if (disposed || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data?.type === "artifacts/preview-state") { bridge.state = data.state; return; }
    if (data?.type === "artifacts/preview-route") {
      if (bridge.route && typeof data.path === "string" && data.path.startsWith("/") && !data.path.startsWith("//")) bridge.route.path = data.path;
      return;
    }
    if (data?.type === "artifacts/preview-error") { onError(String(data.message)); return; }
    if (data?.type !== "artifacts/preview-call" || !methods.includes(data.method) || !Number.isSafeInteger(data.id)) return;
    try {
      const handler = bridge[data.method as PreviewMethod] as (value: unknown) => unknown;
      const result = await handler(data.value);
      if (!disposed) frame.contentWindow?.postMessage({ type: "artifacts/preview-result", id: data.id, result }, "*");
    } catch (error) {
      if (!disposed) frame.contentWindow?.postMessage({ type: "artifacts/preview-result", id: data.id, error: error instanceof Error ? error.message : String(error) }, "*");
    }
  };
  window.addEventListener("message", receive);
  frame.srcdoc = html;
  container.append(frame);
  return {
    bridge,
    update() {
      const { state: _state, route: _route, ...value } = context();
      frame.contentWindow?.postMessage({ type: "artifacts/preview-context", context: value }, "*");
    },
    dispose() { disposed = true; window.removeEventListener("message", receive); frame.remove(); },
  };
}
