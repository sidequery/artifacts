import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { themeFromKind, type CanvasHostTheme } from "./tokens";

export type CanvasAction =
  | { type: "openFile"; path: string; selection?: { startLine?: number; endLine?: number } }
  | { type: "promptAgent"; prompt: string }
  | { type: "openUrl"; url: string };

export type SetCanvasState<T> = Dispatch<SetStateAction<T>>;

export type HostBridge = {
  canvasId?: string;
  state?: Record<string, unknown>;
  theme?: { kind?: string };
  persistUrl?: string;
  actionUrl?: string;
  onAction?: (action: CanvasAction) => void;
};

function hostBridge(): HostBridge {
  if (typeof window === "undefined") {
    return {};
  }
  return (window as Window & { __herdrCanvas?: HostBridge }).__herdrCanvas ?? {};
}

export function themeKindFromHost(kind: string | undefined, prefersLight: boolean): "dark" | "light" {
  if (kind === "light" || kind === "dark") {
    return kind;
  }
  return prefersLight ? "light" : "dark";
}

export function useHostTheme(): CanvasHostTheme {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const changed = () => setGeneration(value => value + 1);
    window.addEventListener("canvas-theme-change", changed);
    return () => window.removeEventListener("canvas-theme-change", changed);
  }, []);
  return useMemo(() => {
    const prefersLight = typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches);
    return themeFromKind(themeKindFromHost(hostBridge().theme?.kind, prefersLight));
  }, [generation]);
}

export function useCanvasState<T>(key: string, defaultValue: T): [T, SetCanvasState<T>] {
  const [value, setValue] = useState<T>(() => {
    const stored = hostBridge().state?.[key];
    return stored === undefined ? defaultValue : (stored as T);
  });

  const persistUrl = hostBridge().persistUrl;
  const setter: SetCanvasState<T> = (action) => {
    setValue((prev) => {
      const next = typeof action === "function" ? (action as (current: T) => T)(prev) : action;
      if (persistUrl) {
        void persistState(persistUrl, key, next);
      } else {
        const bridge = hostBridge();
        bridge.state = { ...bridge.state, [key]: next };
      }
      return next;
    });
  };

  return [value, setter];
}

export function useCanvasAction(): (action: CanvasAction) => void {
  const actionUrl = hostBridge().actionUrl;
  return (action) => {
    if (hostBridge().onAction) {
      hostBridge().onAction!(action);
      return;
    }
    if (!actionUrl) {
      return;
    }
    void fetch(actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
  };
}

async function persistState(url: string, key: string, value: unknown): Promise<void> {
  await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}
