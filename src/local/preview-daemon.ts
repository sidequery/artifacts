import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CLI_ENTRY } from "../paths";
import { createArtifactServer, type ArtifactServer } from "../serve";
import { historyPath } from "../history";

export type DaemonState = {
  pid: number;
  port: number;
  url: string;
  artifactsDir: string;
  historyDb: string;
};

export type SpawnDaemon = (args: string[], statePath: string) => { pid: number };
export type HealthCheck = (url: string) => Promise<boolean>;

export function daemonStatePath(artifactsDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.HERDR_PLUGIN_STATE_DIR ?? join(tmpdir(), "artifacts");
  const id = createHash("sha256").update(`${artifactsDir}\0${historyPath(env)}`).digest("hex").slice(0, 12);
  return join(root, id, "state.json");
}

export function readDaemonState(path: string): DaemonState | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DaemonState;
  } catch {
    return undefined;
  }
}

export function writeDaemonState(path: string, state: DaemonState): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureArtifactServer(opts: {
  artifactsDir: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnDaemon;
  health?: HealthCheck;
  inProcess?: boolean;
}): Promise<{ server?: ArtifactServer; url: string; reused: boolean }> {
  const env = opts.env ?? process.env;
  if (env.ARTIFACTS_SERVER_URL) {
    return { url: env.ARTIFACTS_SERVER_URL, reused: true };
  }

  const statePath = daemonStatePath(opts.artifactsDir, env);
  const existing = readDaemonState(statePath);
  const health = opts.health ?? isHealthy;
  if (existing && existing.historyDb === historyPath(env) && (await health(existing.url))) {
    return { url: existing.url, reused: true };
  }

  if (opts.inProcess) {
    const server = await createArtifactServer({
      artifactsDir: opts.artifactsDir,
      port: opts.port ?? 0,
      env,
    });
    writeDaemonState(statePath, {
      pid: process.pid,
      port: server.port,
      url: server.url,
      artifactsDir: opts.artifactsDir,
      historyDb: historyPath(env),
    });
    return { server, url: server.url, reused: false };
  }

  const spawn =
    opts.spawn ??
    ((args) => {
      const [command, ...commandArgs] = args;
      if (!command) {
        throw new Error("missing daemon command");
      }
      const subprocess = spawnProcess(command, commandArgs, {
        detached: true,
        stdio: "ignore",
        env,
      });
      subprocess.unref();
      return { pid: subprocess.pid ?? 0 };
    });

  spawn(
    [
      process.execPath,
      CLI_ENTRY,
      "serve",
      "--dir",
      opts.artifactsDir,
      "--port",
      String(opts.port ?? 0),
      "--daemon",
    ],
    statePath,
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = readDaemonState(statePath);
    if (state && state.historyDb === historyPath(env) && (await health(state.url))) {
      return { url: state.url, reused: false };
    }
    await Bun.sleep(100);
  }

  throw new Error("failed to start artifacts server");
}
