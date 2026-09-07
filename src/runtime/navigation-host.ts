/** Only the trusted standalone wrapper owns the real browser URL. */
export function installNavigationHost(frame: HTMLIFrameElement, basePath: string) {
  const currentPath = () => (location.pathname.slice(basePath.length) || "/") + location.search + location.hash;
  const send = (action = "POP") => frame.contentWindow?.postMessage({
    type: "canvas/location", path: currentPath(), action,
    state: history.state?.__canvasRoute?.state ?? null,
    key: history.state?.__canvasRoute?.key ?? "initial",
  }, "*");
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const value = event.data;
    if (value?.type === "canvas/navigation-ready") { send(); return; }
    if (value?.type !== "canvas/navigate") return;
    if (value.action === "POP") {
      if (Number.isSafeInteger(value.delta) && value.delta !== 0) history.go(value.delta);
      return;
    }
    if (!["PUSH", "REPLACE"].includes(value.action) || typeof value.path !== "string" || value.path.length > 8192
      || !value.path.startsWith("/") || value.path.startsWith("//") || value.path.includes("\\")) return;
    const next = new URL(value.path, location.origin);
    if (next.origin !== location.origin || /^\/(?:api|_canvas)(?:\/|$)/.test(next.pathname)) return;
    const path = next.pathname + next.search + next.hash;
    const state = { ...history.state, __canvasRoute: { state: value.state ?? null, key: crypto.randomUUID() } };
    try {
      if (value.action === "REPLACE") history.replaceState(state, "", basePath + path);
      else history.pushState(state, "", basePath + path);
      send(value.action);
    } catch { /* An uncloneable or oversized history state must not change the route. */ }
  };
  const pop = () => send();
  window.addEventListener("message", receive);
  window.addEventListener("popstate", pop);
  window.addEventListener("hashchange", pop);
  return () => {
    window.removeEventListener("message", receive);
    window.removeEventListener("popstate", pop);
    window.removeEventListener("hashchange", pop);
  };
}

const config = (window as Window & { __canvasNavigationHost?: { frame: HTMLIFrameElement; basePath: string } }).__canvasNavigationHost;
if (config) installNavigationHost(config.frame, config.basePath);
