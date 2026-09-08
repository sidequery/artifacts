import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { themeFromKind, type ArtifactHostTheme } from "./tokens";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "./server";
import type { PluginRequest } from "../plugins/types";
import type { ArtifactFileRequest } from "./files";

export type ArtifactAction =
  | { type: "openFile"; path: string; selection?: { startLine?: number; endLine?: number } }
  | { type: "promptAgent"; prompt: string }
  | { type: "openUrl"; url: string };

export type SetArtifactState<T> = Dispatch<SetStateAction<T>>;

export type HostBridge = {
  route?: import("./routing").ArtifactRoute;
  artifactId?: string;
  state?: Record<string, unknown>;
  theme?: { kind?: string };
  persistUrl?: string;
  actionUrl?: string;
  onAction?: (action: ArtifactAction) => void;
  onRequest?: (request: ArtifactHttpRequest) => Promise<ArtifactHttpResponse>;
  onPluginCall?: (request: PluginRequest) => Promise<unknown>;
  onFileRequest?: (request: ArtifactFileRequest) => Promise<unknown>;
  onFileDownload?: (url: string) => Promise<void>;
};

function hostBridge(): HostBridge {
  if (typeof window === "undefined") {
    return {};
  }
  return (window as Window & { __artifacts?: HostBridge }).__artifacts ?? {};
}

export function themeKindFromHost(kind: string | undefined, prefersLight: boolean): "dark" | "light" {
  if (kind === "light" || kind === "dark") {
    return kind;
  }
  return prefersLight ? "light" : "dark";
}

export function useHostTheme(): ArtifactHostTheme {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const changed = () => setGeneration(value => value + 1);
    window.addEventListener("artifact-theme-change", changed);
    return () => window.removeEventListener("artifact-theme-change", changed);
  }, []);
  return useMemo(() => {
    const prefersLight = typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches);
    return themeFromKind(themeKindFromHost(hostBridge().theme?.kind, prefersLight));
  }, [generation]);
}

export function useArtifactState<T>(key: string, defaultValue: T): [T, SetArtifactState<T>] {
  const [value, setValue] = useState<T>(() => {
    const stored = hostBridge().state?.[key];
    return stored === undefined ? defaultValue : (stored as T);
  });

  const persistUrl = hostBridge().persistUrl;
  const setter: SetArtifactState<T> = (action) => {
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

export function useArtifactAction(): (action: ArtifactAction) => void {
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
