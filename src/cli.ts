#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runHostCommand } from "./local/host";
import { flagBoolean, flagString, parseArgs, type ParsedArgs } from "./args";
import { artifactsDirFrom } from "./artifactFile";
import { clearServerReady, ServerDaemonManager, writeServerReady } from "./local/server-daemon";
import { runCelldServer } from "./local/server";
import { writeDaemonState, daemonStatePath } from "./local/preview-daemon";
import { createHerdrClient, type PanePlacement } from "./herdr";
import { runMcpServer } from "./mcp/stdio";
import { createArtifactServer } from "./serve";
import { ArtifactService } from "./service";
import { historyPath } from "./history";
import { PLUGIN_ROOT } from "./paths";

type ServerManager = Pick<ServerDaemonManager, "start" | "stop" | "status" | "logs" | "uninstall">;

export async function runServerCommand(args: ParsedArgs, dependencies: {
  manager?: ServerManager;
  runForeground?: typeof runCelldServer;
  signal?: AbortSignal;
  stdout?: (value: string) => void;
} = {}): Promise<boolean> {
  if (args.command !== "server") return false;
  const action = args.positionals[0];
  if (args.positionals.length > 1) throw new Error("server accepts at most one subcommand");
  const stdout = dependencies.stdout ?? (value => process.stdout.write(value));
  const numberFlag = (key: string, fallback?: number) => {
    const raw = args.flags[key];
    return raw === undefined ? fallback : Number(raw === true ? NaN : raw);
  };

  if (action) {
    if (flagString(args.flags, "state-dir") || flagString(args.flags, "managed-ready")) {
      throw new Error("--state-dir is available only for foreground `artifacts server`");
    }
    const manager = dependencies.manager ?? new ServerDaemonManager();
    if (action === "start") {
      stdout(`${JSON.stringify(await manager.start({ atLogin: flagBoolean(args.flags, "at-login"), port: numberFlag("port") }), null, 2)}\n`);
    } else if (action === "stop") {
      stdout(`${JSON.stringify(await manager.stop(), null, 2)}\n`);
    } else if (action === "status") {
      stdout(`${JSON.stringify(await manager.status(), null, 2)}\n`);
    } else if (action === "logs") {
      stdout((await manager.logs(numberFlag("lines", 100))).contents);
    } else if (action === "uninstall") {
      stdout(`${JSON.stringify(await manager.uninstall(), null, 2)}\n`);
    } else {
      throw new Error(`unknown server subcommand: ${action}`);
    }
    return true;
  }

  if (flagBoolean(args.flags, "at-login")) throw new Error("use `artifacts server start --at-login` to enable start at login");
  const port = numberFlag("port");
  const stateDir = flagString(args.flags, "state-dir");
  const readyPath = flagString(args.flags, "managed-ready");
  if (readyPath && !stateDir) throw new Error("internal --managed-ready requires --state-dir");
  const controller = dependencies.signal ? undefined : new AbortController();
  const signal = dependencies.signal ?? controller!.signal;
  let readyWrite: Promise<void> | undefined;
  const stop = () => controller?.abort();
  if (controller) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  try {
    await (dependencies.runForeground ?? runCelldServer)({
      port,
      stateDir,
      signal,
      onReady: async url => {
        stdout(`${JSON.stringify({ ok: true, url, port: Number(new URL(url).port), stateDir: stateDir ? resolve(stateDir) : undefined }, null, 2)}\n`);
        if (readyPath) {
          readyWrite = writeServerReady(resolve(readyPath), {
            pid: process.pid,
            port: Number(new URL(url).port),
            url,
            stateDir: resolve(stateDir!),
          });
          await readyWrite;
        }
      },
    });
  } catch (error) {
    const abortError = error === signal.reason || (error instanceof Error && error.name === "AbortError");
    if (!signal.aborted || !abortError) throw error;
  } finally {
    if (controller) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (readyWrite) await readyWrite;
    if (readyPath) await clearServerReady(resolve(readyPath));
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  if (args.command === "version" || args.command === "--version" || args.command === "-v") {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")) as { name: string; version: string };
    console.log(`${manifest.name} ${manifest.version}`);
    return;
  }

  if (await runHostCommand(args)) return;
  if (await runServerCommand(args)) return;

  const cwd = process.cwd();
  const artifactsDir = resolve(flagString(args.flags, "dir") ?? artifactsDirFrom(cwd));
  const historyDb = flagString(args.flags, "history-db");
  const env = historyDb ? { ...process.env, ARTIFACTS_HISTORY_DB: resolve(historyDb) } : process.env;
  const service = new ArtifactService({
    cwd,
    artifactsDir,
    herdr: createHerdrClient(),
    inProcessServer: flagBoolean(args.flags, "in-process"),
    env,
  });

  if (args.command === "remix") {
    const versionId = flagString(args.flags, "version");
    if (args.positionals.length !== (versionId ? 1 : 2)) throw new Error("use remix SOURCE NEW_NAME or remix NEW_NAME --version ID");
    const result = service.remix({ name: versionId ? undefined : args.positionals[0], version_id: versionId,
      new_name: args.positionals[versionId ? 0 : 1]! });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "history") {
    printJson({ ok: true, versions: service.history(args.positionals[0]) });
    return;
  }

  if (["show", "restore"].includes(args.command)) {
    const versionId = args.positionals[0];
    requireArg(versionId, "missing version ID");
    if (args.command === "show") {
      const version = service.version(versionId);
      if (flagBoolean(args.flags, "source")) process.stdout.write(version.source);
      else printJson(version);
    } else if (args.command === "restore") {
      const result = service.restore(versionId);
      printJson(result);
      if (!result.ok) process.exitCode = 1;
    }
    return;
  }

  if (args.command === "list") {
    printJson({ ok: true, artifacts: service.list(), dir: artifactsDir });
    return;
  }

  if (args.command === "write") {
    const name = args.positionals[0];
    requireArg(name, "missing artifact name");
    const contents = await readContents(args);
    const projectFile = flagString(args.flags, "project");
    printJson(projectFile ? await service.writeProject(name, contents, JSON.parse(await Bun.file(projectFile).text())) : service.write(name, contents));
    return;
  }

  if (args.command === "read") {
    const name = args.positionals[0];
    requireArg(name, "missing artifact name");
    const lineFlag = (key: string) => args.flags[key] === undefined ? undefined : Number(args.flags[key] === true ? NaN : args.flags[key]);
    printJson(service.readRange(name, { file: flagString(args.flags, "source-file"), start_line: lineFlag("start-line"), end_line: lineFlag("end-line") }));
    return;
  }

  if (args.command === "edit") {
    const name = args.positionals[0];
    requireArg(name, "missing artifact name");
    const payload: unknown = JSON.parse(await readContents(args));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("edit input must be an object with edits and optional expected_hash");
    const input = payload as { edits: Parameters<ArtifactService["edit"]>[1]; expected_hash?: string };
    const result = service.edit(name, input.edits, input.expected_hash, flagString(args.flags, "source-file"));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "typecheck") {
    const name = args.positionals[0];
    requireArg(name, "missing artifact name");
    printJson(service.typecheck(name));
    return;
  }

  if (args.command === "compile") {
    const name = args.positionals[0];
    requireArg(name, "missing artifact name");
    const result = await service.compile(name);
    printJson({
      ok: result.ok,
      path: result.path,
      check: result.check,
      diagnostics: result.diagnostics,
      bytes: result.js?.length ?? 0,
    });
    return;
  }

  if (args.command === "open") {
    const name = args.positionals[0] ?? (args.flags.version === undefined ? process.env.ARTIFACTS_NAME : undefined);
    const versionId = flagString(args.flags, "version");
    if (Boolean(name) === Boolean(versionId)) throw new Error("provide an artifact name or --version ID, but not both");
    const result = await service.open(name ?? "", {
      versionId,
      eventId: flagString(args.flags, "event"),
      placement: (flagString(args.flags, "placement") as PanePlacement | undefined) ?? "split",
      direction: flagString(args.flags, "direction") === "down" ? "down" : "right",
      skipOpen: flagBoolean(args.flags, "no-open"),
    });
    printJson(result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "serve" || args.command === "web") {
    const gallery = args.command === "web";
    const port = Number(flagString(args.flags, "port") ?? (gallery ? "4784" : "0"));
    const server = await createArtifactServer({ artifactsDir, port, env, gallery });
    if (!gallery) writeDaemonState(daemonStatePath(artifactsDir, env), {
      pid: process.pid,
      port: server.port,
      url: server.url,
      artifactsDir,
      historyDb: historyPath(env),
    });
    printJson({ ok: true, url: server.url, port: server.port, dir: artifactsDir });
    if (gallery) {
      const stop = () => { server.stop(); process.exit(0); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    await new Promise(() => {});
    return;
  }

  if (args.command === "mcp") {
    await runMcpServer(service);
    return;
  }

  throw new Error(`unknown command: ${args.command}`);
}

async function readContents(args: ReturnType<typeof parseArgs>): Promise<string> {
  const file = flagString(args.flags, "file", "f");
  if (file) {
    return await Bun.file(file).text();
  }
  if (flagBoolean(args.flags, "stdin") || args.positionals.length < 2) {
    return await Bun.stdin.text();
  }
  return args.positionals.slice(1).join(" ");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function requireArg(value: string | undefined, message: string): asserts value is string {
  if (!value) {
    throw new Error(message);
  }
}

function printHelp(): void {
  console.log(`artifacts

Usage:
  artifacts --version
  artifacts list [--dir PATH]
  artifacts write NAME [--file PATH | --stdin] [--project PROJECT_JSON]
  artifacts read NAME [--source-file PATH] [--start-line N] [--end-line N]
  artifacts edit NAME [--source-file PATH] [--file PATH | --stdin]
  artifacts typecheck NAME
  artifacts compile NAME
  artifacts open NAME [--placement split|tab|zoomed|overlay] [--no-open]
  artifacts serve [--dir PATH] [--port N]
  artifacts web [--port 4784] [--dir PATH]
  artifacts mcp
  artifacts history [NAME]
  artifacts show VERSION_ID [--source]
  artifacts open --version VERSION_ID [--event EVENT_ID] [--placement split|tab|zoomed|overlay]
  artifacts restore VERSION_ID
  artifacts remix SOURCE NEW_NAME
  artifacts remix NEW_NAME --version VERSION_ID
  artifacts server [--port 4786] [--state-dir PATH]
  artifacts server start [--port 4786] [--at-login]
  artifacts server stop | status | logs [--lines 100] | uninstall
  artifacts host install --origin https://HOST.ts.net --tailscale-login LOGIN [--serve]
    [--runner-org ORG --runner-repos ORG/REPO,...] [--gh-path PATH] [--replace-serve] [--keep-warm]
    [--warm-gallery] [--warm-canvases NAME,...]
  artifacts host start | stop | status | logs [--lines 100] | backup | uninstall
    [--data-dir PATH]

All commands accept --dir PATH and --history-db PATH.
read returns up to 200 lines by default, with a source_hash and next_line.
edit accepts JSON: {"edits":[{"old_text":"exact match","new_text":"replacement"}],"expected_hash":"optional SHA-256"}.
Edits run sequentially in memory; every old_text must match exactly once. Invalid batches
write nothing. Successful batches replace atomically, then typecheck once; diagnostics
do not roll back applied edits. Results omit source text.
History keeps source and dependency snapshots. Opening a saved version builds with the installed SDK and uses
isolated UI state. Restore archives the working copy and adds a new revision.

Artifacts live in <workspace>/artifacts/*.artifact.tsx and import the SDK from
"sidequery/artifacts", plus declared project helpers and dependencies. open creates a managed Artifact pane
powered internally by Terminal Browser in app mode.
`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
