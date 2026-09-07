import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MemoryRouter, Router, NavigationType, createPath, parsePath, type Location, type Navigator } from "react-router";

export { Routes, Route, Outlet, Navigate, NavLink, useNavigate, useParams, useLocation, useSearchParams, useMatch, useResolvedPath } from "react-router";
export type { RouteObject, NavigateOptions, To } from "react-router";

export type CanvasRoute = { path: string; basePath: string; external: true };

/** The viewer owns browser history; embedded canvases keep their own history. */
export function CanvasRouter({ children }: { children: ReactNode }) {
  const route = (globalThis as typeof globalThis & { __herdrCanvas?: { route?: CanvasRoute } }).__herdrCanvas?.route;
  return route?.external && window.parent !== window
    ? <HostedRouter route={route}>{children}</HostedRouter>
    : <MemoryRouter>{children}</MemoryRouter>;
}

function HostedRouter({ route, children }: { route: CanvasRoute; children: ReactNode }) {
  const [current, setCurrent] = useState<{ location: Location; action: NavigationType }>(() => ({
    location: { pathname: "/", search: "", hash: "", ...parsePath(route.path), state: null, key: "initial" },
    action: NavigationType.Pop,
  }));
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (event.source !== window.parent || value?.type !== "canvas/location" || typeof value.path !== "string"
        || !value.path.startsWith("/") || !["POP", "PUSH", "REPLACE"].includes(value.action)) return;
      setCurrent({ location: { pathname: "/", search: "", hash: "", ...parsePath(value.path), state: value.state ?? null, key: String(value.key ?? "default") }, action: value.action });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "canvas/navigation-ready" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);
  const navigator = useMemo<Navigator>(() => ({
    createHref: to => route.basePath + (typeof to === "string" ? to : createPath(to)),
    go: delta => window.parent.postMessage({ type: "canvas/navigate", action: "POP", delta }, "*"),
    push: (to, state) => window.parent.postMessage({ type: "canvas/navigate", action: "PUSH", path: typeof to === "string" ? to : createPath(to), state }, "*"),
    replace: (to, state) => window.parent.postMessage({ type: "canvas/navigate", action: "REPLACE", path: typeof to === "string" ? to : createPath(to), state }, "*"),
  }), [route.basePath]);
  return <Router location={current.location} navigationType={current.action} navigator={navigator}>{children}</Router>;
}
