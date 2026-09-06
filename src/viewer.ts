#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { canvasIdFromFile } from "./canvasFile";
import { compileCanvas } from "./compile";
import { formatCanvasCheck } from "./diagnostics";
import { createCanvasServer, type CanvasServer } from "./serve";
import { typecheckCanvas } from "./typecheck";
import { CanvasHistory, historyPath } from "./history";

type ViewerSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export type CanvasPaneConfig = {
  canvasPath: string;
  canvasesDir: string;
  canvasId: string;
  versionId?: string;
  eventId?: string;
};

export type TerminalBrowserChild = {
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): TerminalBrowserChild;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): TerminalBrowserChild;
};

export function canvasPaneConfig(env: NodeJS.ProcessEnv = process.env): CanvasPaneConfig {
  const rawPath = env.HERDR_CANVAS_PATH?.trim();
  if (!rawPath) {
    throw new Error("HERDR_CANVAS_PATH is required for a Canvas pane");
  }
  const canvasPath = resolve(rawPath);
  const canvasesDir = resolve(env.HERDR_CANVAS_DIR?.trim() || dirname(canvasPath));
  const withinDir = relative(canvasesDir, canvasPath);
  if (!withinDir || withinDir.startsWith("..") || isAbsolute(withinDir)) {
    throw new Error(`canvas path must be inside the canvases directory: ${canvasPath}`);
  }
  const versionId = env.HERDR_CANVAS_VERSION?.trim();
  if (!versionId && !existsSync(canvasPath)) {
    throw new Error(`canvas file does not exist: ${canvasPath}`);
  }
  return {
    canvasPath,
    canvasesDir,
    canvasId: canvasIdFromFile(canvasPath),
    ...(versionId ? { versionId, eventId: env.HERDR_CANVAS_EVENT?.trim() || undefined } : {}),
  };
}

export function terminalBrowserCommand(url: string, bin = "terminal-browser"): string[] {
  return [bin, "open", url, "--app-mode"];
}

export function paneInputCommand(env: NodeJS.ProcessEnv): string[] {
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) {
    throw new Error("HERDR_PANE_ID is required for an interactive Canvas pane");
  }
  return [env.HERDR_BIN_PATH?.trim() || "herdr", "pane", "input", "--pane", paneId, "--right-click", "pane"];
}

export async function runManagedCanvasPane(opts: {
  config: CanvasPaneConfig;
  env?: NodeJS.ProcessEnv;
  terminalBrowserBin?: string;
  createServer?: typeof createCanvasServer;
  spawnBrowser?: (command: string[], env: NodeJS.ProcessEnv) => TerminalBrowserChild;
  configurePaneInput?: (command: string[], env: NodeJS.ProcessEnv) => void;
}): Promise<number> {
  const childEnv = opts.env ?? process.env;
  let snapshot: string | undefined;
  if (opts.config.versionId) {
    const archive = new CanvasHistory(historyPath(childEnv));
    try {
      const version = archive.version(opts.config.versionId, opts.config.canvasesDir);
      if (!version) throw new Error("version not found in this workspace");
      snapshot = version.source;
    } finally { archive.close(); }
  }
  const diagnostics = snapshot === undefined ? typecheckCanvas(opts.config.canvasPath) : [];
  if (diagnostics.length > 0) {
    throw new Error(formatCanvasCheck(diagnostics));
  }
  const compiled = await compileCanvas(opts.config.canvasPath, snapshot);
  if (!compiled.ok) {
    throw new Error(formatCanvasCheck(compiled.diagnostics));
  }

  const inputCommand = paneInputCommand(childEnv);
  if (opts.configurePaneInput) {
    opts.configurePaneInput(inputCommand, childEnv);
  } else {
    const input = spawnSync(inputCommand[0], inputCommand.slice(1), {
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (input.status !== 0) {
      throw new Error(`failed to enable Canvas pane mouse input: ${(input.stderr || input.stdout).trim()}`);
    }
  }

  const createServer = opts.createServer ?? createCanvasServer;
  let server: CanvasServer | undefined;
  let child: TerminalBrowserChild | undefined;
  const listeners = new Map<ViewerSignal, () => void>();
  let requestedExitCode: number | undefined;

  try {
    server = await createServer({ canvasesDir: opts.config.canvasesDir, env: childEnv });
    const route = opts.config.versionId
      ? `/v/${opts.config.versionId}${opts.config.eventId ? `?event=${encodeURIComponent(opts.config.eventId)}` : ""}`
      : `/c/${encodeURIComponent(opts.config.canvasId)}`;
    const url = `${server.url}${route}`;
    const terminalBrowserBin = opts.terminalBrowserBin ?? (
      childEnv.HERDR_TERMINAL_BROWSER_BIN?.trim() || "terminal-browser"
    );
    const command = terminalBrowserCommand(url, terminalBrowserBin);
    child = opts.spawnBrowser
      ? opts.spawnBrowser(command, childEnv)
      : spawn(command[0], command.slice(1), {
          env: childEnv,
          stdio: "inherit",
        }) as TerminalBrowserChild;

    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const listener = () => {
        requestedExitCode = exitCode;
        if (child && !child.killed) {
          child.kill(signal);
        }
      };
      listeners.set(signal, listener);
      process.once(signal, listener);
    }

    const code = await waitForChild(child);
    return requestedExitCode ?? code;
  } finally {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    server?.stop();
  }
}

function waitForChild(child: TerminalBrowserChild): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null) {
        resolveExit(code);
        return;
      }
      resolveExit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : signal === "SIGTERM" ? 143 : 1);
    });
  });
}

async function main(): Promise<void> {
  const config = canvasPaneConfig();
  const exitCode = await runManagedCanvasPane({ config });
  process.exitCode = exitCode;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
