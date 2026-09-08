/** Only the trusted standalone wrapper owns the real browser URL. */
export function installNavigationHost(frame: HTMLIFrameElement, basePath: string) {
  let protocol: "artifact" | "canvas" = "artifact";
  const routeState = () => history.state?.__artifactRoute ?? history.state?.__canvasRoute;
  const currentPath = () => (location.pathname.slice(basePath.length) || "/") + location.search + location.hash;
  const send = (action = "POP") => frame.contentWindow?.postMessage({
    type: `${protocol}/location`, path: currentPath(), action,
    state: routeState()?.state ?? null,
    key: routeState()?.key ?? "initial",
  }, "*");
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    const value = event.data;
    if (value?.type === "artifact/navigation-ready" || value?.type === "canvas/navigation-ready") {
      protocol = value.type === "canvas/navigation-ready" ? "canvas" : "artifact";
      send(); return;
    }
    if (value?.type !== `${protocol}/navigate`) return;
    if (value.action === "POP") {
      if (Number.isSafeInteger(value.delta) && value.delta !== 0) history.go(value.delta);
      return;
    }
    if (!["PUSH", "REPLACE"].includes(value.action) || typeof value.path !== "string" || value.path.length > 8192
      || !value.path.startsWith("/") || value.path.startsWith("//") || value.path.includes("\\")) return;
    const next = new URL(value.path, location.origin);
    if (next.origin !== location.origin || /^\/(?:api|_artifact|_canvas)(?:\/|$)/.test(next.pathname)) return;
    const path = next.pathname + next.search + next.hash;
    const route = { state: value.state ?? null, key: crypto.randomUUID() };
    const state = { ...history.state, __artifactRoute: route, __canvasRoute: route };
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

type NavigationConfig = { frame: HTMLIFrameElement; basePath: string };
const hostWindow = window as Window & { __artifactNavigationHost?: NavigationConfig; __canvasNavigationHost?: NavigationConfig };
const config = hostWindow.__artifactNavigationHost ?? hostWindow.__canvasNavigationHost;
if (config) installNavigationHost(config.frame, config.basePath);
