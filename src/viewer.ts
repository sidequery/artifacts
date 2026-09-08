#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { artifactIdFromFile } from "./artifactFile";
import { compileArtifact } from "./compile";
import { formatArtifactCheck } from "./diagnostics";
import { createArtifactServer, type ArtifactServer } from "./serve";
import { typecheckArtifact } from "./typecheck";
import { ArtifactHistory, historyPath } from "./history";

type ViewerSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export type ArtifactPaneConfig = {
  artifactPath: string;
  artifactsDir: string;
  artifactId: string;
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

export function artifactPaneConfig(env: NodeJS.ProcessEnv = process.env): ArtifactPaneConfig {
  const rawPath = (env.ARTIFACTS_PATH ?? env.HERDR_CANVAS_PATH)?.trim();
  if (!rawPath) {
    throw new Error("ARTIFACTS_PATH is required for an Artifact pane");
  }
  const artifactPath = resolve(rawPath);
  const artifactsDir = resolve((env.ARTIFACTS_DIR ?? env.HERDR_CANVAS_DIR)?.trim() || dirname(artifactPath));
  const withinDir = relative(artifactsDir, artifactPath);
  if (!withinDir || withinDir.startsWith("..") || isAbsolute(withinDir)) {
    throw new Error(`artifact path must be inside the artifacts directory: ${artifactPath}`);
  }
  const versionId = (env.ARTIFACTS_VERSION ?? env.HERDR_CANVAS_VERSION)?.trim();
  if (!versionId && !existsSync(artifactPath)) {
    throw new Error(`artifact file does not exist: ${artifactPath}`);
  }
  return {
    artifactPath,
    artifactsDir,
    artifactId: artifactIdFromFile(artifactPath),
    ...(versionId ? { versionId, eventId: (env.ARTIFACTS_EVENT ?? env.HERDR_CANVAS_EVENT)?.trim() || undefined } : {}),
  };
}

export function terminalBrowserCommand(url: string, bin = "terminal-browser"): string[] {
  return [bin, "open", url, "--app-mode"];
}

export function paneInputCommand(env: NodeJS.ProcessEnv): string[] {
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) {
    throw new Error("HERDR_PANE_ID is required for an interactive Artifact pane");
  }
  return [env.HERDR_BIN_PATH?.trim() || "herdr", "pane", "input", "--pane", paneId, "--right-click", "pane"];
}

export async function runManagedArtifactPane(opts: {
  config: ArtifactPaneConfig;
  env?: NodeJS.ProcessEnv;
  terminalBrowserBin?: string;
  createServer?: typeof createArtifactServer;
  spawnBrowser?: (command: string[], env: NodeJS.ProcessEnv) => TerminalBrowserChild;
  configurePaneInput?: (command: string[], env: NodeJS.ProcessEnv) => void;
}): Promise<number> {
  const childEnv = opts.env ?? process.env;
  let snapshot: string | undefined;
  if (opts.config.versionId) {
    const archive = new ArtifactHistory(historyPath(childEnv));
    try {
      const version = archive.version(opts.config.versionId, opts.config.artifactsDir);
      if (!version) throw new Error("version not found in this workspace");
      snapshot = version.source;
    } finally { archive.close(); }
  }
  const diagnostics = snapshot === undefined ? typecheckArtifact(opts.config.artifactPath) : [];
  if (diagnostics.length > 0) {
    throw new Error(formatArtifactCheck(diagnostics));
  }
  const compiled = await compileArtifact(opts.config.artifactPath, snapshot);
  if (!compiled.ok) {
    throw new Error(formatArtifactCheck(compiled.diagnostics));
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
      throw new Error(`failed to enable Artifact pane mouse input: ${(input.stderr || input.stdout).trim()}`);
    }
  }

  const createServer = opts.createServer ?? createArtifactServer;
  let server: ArtifactServer | undefined;
  let child: TerminalBrowserChild | undefined;
  const listeners = new Map<ViewerSignal, () => void>();
  let requestedExitCode: number | undefined;

  try {
    server = await createServer({ artifactsDir: opts.config.artifactsDir, env: childEnv });
    const route = opts.config.versionId
      ? `/v/${opts.config.versionId}${opts.config.eventId ? `?event=${encodeURIComponent(opts.config.eventId)}` : ""}`
      : `/c/${encodeURIComponent(opts.config.artifactId)}`;
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
  const config = artifactPaneConfig();
  const exitCode = await runManagedArtifactPane({ config });
  process.exitCode = exitCode;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
