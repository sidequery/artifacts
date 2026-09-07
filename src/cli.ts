#!/usr/bin/env bun

import { resolve } from "node:path";

import { flagBoolean, flagString, parseArgs } from "./args";
import { canvasesDirFrom } from "./canvasFile";
import { writeDaemonState, daemonStatePath } from "./daemon";
import { createHerdrClient, type PanePlacement } from "./herdr";
import { runMcpServer } from "./mcpServer";
import { createCanvasServer } from "./serve";
import { CanvasService } from "./service";
import { historyPath } from "./history";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const canvasesDir = resolve(flagString(args.flags, "dir") ?? canvasesDirFrom(cwd));
  const historyDb = flagString(args.flags, "history-db");
  const env = historyDb ? { ...process.env, HERDR_CANVAS_HISTORY_DB: resolve(historyDb) } : process.env;
  const service = new CanvasService({
    cwd,
    canvasesDir,
    herdr: createHerdrClient(),
    inProcessServer: flagBoolean(args.flags, "in-process"),
    env,
  });

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
    printJson({ ok: true, canvases: service.list(), dir: canvasesDir });
    return;
  }

  if (args.command === "write") {
    const name = args.positionals[0];
    requireArg(name, "missing canvas name");
    const contents = await readContents(args);
    printJson(service.write(name, contents));
    return;
  }

  if (args.command === "read") {
    const name = args.positionals[0];
    requireArg(name, "missing canvas name");
    const lineFlag = (key: string) => args.flags[key] === undefined ? undefined : Number(args.flags[key] === true ? NaN : args.flags[key]);
    printJson(service.readRange(name, { start_line: lineFlag("start-line"), end_line: lineFlag("end-line") }));
    return;
  }

  if (args.command === "edit") {
    const name = args.positionals[0];
    requireArg(name, "missing canvas name");
    const payload: unknown = JSON.parse(await readContents(args));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("edit input must be an object with edits and optional expected_hash");
    const input = payload as { edits: Parameters<CanvasService["edit"]>[1]; expected_hash?: string };
    const result = service.edit(name, input.edits, input.expected_hash);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "typecheck") {
    const name = args.positionals[0];
    requireArg(name, "missing canvas name");
    printJson(service.typecheck(name));
    return;
  }

  if (args.command === "compile") {
    const name = args.positionals[0];
    requireArg(name, "missing canvas name");
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
    const name = args.positionals[0];
    const versionId = flagString(args.flags, "version");
    if (Boolean(name) === Boolean(versionId)) throw new Error("provide a canvas name or --version ID, but not both");
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
    const server = await createCanvasServer({ canvasesDir, port, env, gallery });
    if (!gallery) writeDaemonState(daemonStatePath(canvasesDir, env), {
      pid: process.pid,
      port: server.port,
      url: server.url,
      canvasesDir,
      historyDb: historyPath(env),
    });
    printJson({ ok: true, url: server.url, port: server.port, dir: canvasesDir });
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
  console.log(`canvas

Usage:
  canvas list [--dir PATH]
  canvas write NAME [--file PATH | --stdin]
  canvas read NAME [--start-line N] [--end-line N]
  canvas edit NAME [--file PATH | --stdin]
  canvas typecheck NAME
  canvas compile NAME
  canvas open NAME [--placement split|tab|zoomed|overlay] [--no-open]
  canvas serve [--dir PATH] [--port N]
  canvas web [--port 4784] [--dir PATH]
  canvas mcp
  canvas history [NAME]
  canvas show VERSION_ID [--source]
  canvas open --version VERSION_ID [--event EVENT_ID] [--placement split|tab|zoomed|overlay]
  canvas restore VERSION_ID

All commands accept --dir PATH and --history-db PATH.
read returns up to 200 lines by default, with a source_hash and next_line.
edit accepts JSON: {"edits":[{"old_text":"exact match","new_text":"replacement"}],"expected_hash":"optional SHA-256"}.
Edits run sequentially in memory; every old_text must match exactly once. Invalid batches
write nothing. Successful batches replace atomically, then typecheck once; diagnostics
do not roll back applied edits. Results omit source text.
History keeps raw TSX only. Opening a saved version builds with the installed SDK and uses
isolated UI state. Restore archives the working copy and adds a new revision.

Canvases live in <workspace>/canvases/*.canvas.tsx and may import only from
"sidequery/canvas". open compiles the artifact and creates a managed Canvas pane
powered internally by Terminal Browser in app mode.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
