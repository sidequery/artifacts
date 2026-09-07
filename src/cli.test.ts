import { expect, test } from "bun:test";
import { join } from "node:path";
import { unlinkSync, readFileSync } from "node:fs";

import { PLUGIN_ROOT } from "./paths";
import { VALID_CANVAS, tempDir, writeCanvas } from "./test/fixtures";
import { CanvasHistory } from "./history";
import { createCanvasServer } from "./serve";
import { handleMcpRequest } from "./mcp";
import { CanvasService } from "./service";
import { parseArgs } from "./args";
import { runServerCommand } from "./cli";

test("CLI reports the installed package version", async () => {
  const manifest = await Bun.file(join(PLUGIN_ROOT, "package.json")).json() as { name: string; version: string };
  const result = await runCli(["--version"]);
  expect(result).toEqual({ exitCode: 0, stdout: `${manifest.name} ${manifest.version}\n`, stderr: "" });
});

test("server CLI dispatches lifecycle commands and foreground readiness", async () => {
  const calls: string[] = [];
  const status = { manager: "launchd" as const, installedAtLogin: false, loaded: true, running: true, ready: true, pid: 7, url: "http://127.0.0.1:4799", logPath: "/tmp/server.log", detail: "ready" };
  const manager = {
    start: async (options: { atLogin?: boolean; port?: number }) => { calls.push(`start:${options.atLogin}:${options.port}`); return status; },
    stop: async () => status,
    status: async () => status,
    logs: async (lines?: number) => { calls.push(`logs:${lines}`); return { path: status.logPath, contents: "last line\n" }; },
    uninstall: async () => status,
  };
  let output = "";
  expect(await runServerCommand(parseArgs(["server", "start", "--port", "4799", "--at-login"]), { manager, stdout: value => { output += value; } })).toBe(true);
  expect(calls).toContain("start:true:4799");
  expect(JSON.parse(output)).toMatchObject({ ready: true, url: status.url });
  output = "";
  await runServerCommand(parseArgs(["server", "logs", "--lines", "1"]), { manager, stdout: value => { output += value; } });
  expect(calls).toContain("logs:1");
  expect(output).toBe("last line\n");

  const stateDir = tempDir();
  let observedReady = false;
  output = "";
  await runServerCommand(parseArgs(["server", "--port", "4799", "--state-dir", stateDir]), {
    signal: new AbortController().signal,
    stdout: value => { output += value; },
    runForeground: async options => {
      await options.onReady?.("http://127.0.0.1:4799");
      observedReady = true;
    },
  });
  expect(observedReady).toBe(true);
  expect(JSON.parse(output)).toMatchObject({ ok: true, port: 4799, stateDir });
  await expect(runServerCommand(parseArgs(["server", "start", "--state-dir", stateDir]), { manager })).rejects.toThrow("foreground");

  const stopped = new AbortController();
  stopped.abort();
  await expect(runServerCommand(parseArgs(["server"]), {
    signal: stopped.signal,
    runForeground: async () => { throw stopped.signal.reason; },
  })).resolves.toBe(true);
  await expect(runServerCommand(parseArgs(["server"]), {
    signal: stopped.signal,
    runForeground: async () => { throw new Error("shutdown cleanup failed"); },
  })).rejects.toThrow("shutdown cleanup failed");
});

test("CLI list and typecheck work against a temp canvases dir", async () => {
  const dir = tempDir();
  writeCanvas(dir, "overview", VALID_CANVAS);
  const list = await runCli(["list", "--dir", dir]);
  expect(list.exitCode).toBe(0);
  const listed = JSON.parse(list.stdout) as { canvases: Array<{ id: string }> };
  expect(listed.canvases.map((item) => item.id)).toEqual(["overview"]);

  const check = await runCli(["typecheck", "overview", "--dir", dir]);
  expect(check.exitCode).toBe(0);
  expect(JSON.parse(check.stdout).check).toBe("Canvas TypeScript check: no errors");
}, { timeout: 30_000 });

test("CLI compile bundles a valid canvas", async () => {
  const dir = tempDir();
  writeCanvas(dir, "overview", VALID_CANVAS);
  const compiled = await runCli(["compile", "overview", "--dir", dir]);
  expect(compiled.exitCode).toBe(0);
  const payload = JSON.parse(compiled.stdout) as { ok: boolean; bytes: number };
  expect(payload.ok).toBe(true);
  expect(payload.bytes).toBeGreaterThan(100);
});

test("CLI history, show, open --version and restore work for an archived canvas whose file was deleted", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const history = new CanvasHistory(dbPath);
  const version = history.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_CANVAS, runtime: "test" });
  const eventId = history.served(version.id, { count: 3 }, "live");
  history.close();
  unlinkSync(path);
  const common = ["--dir", dir, "--history-db", dbPath];
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath });
  try {
    const listing = await runCli(["history", "overview", ...common]);
    expect(listing.exitCode).toBe(0);
    expect(JSON.parse(listing.stdout).versions[0].version_id).toBe(version.id);
    const shown = await runCli(["show", version.id, ...common]);
    expect(JSON.parse(shown.stdout).source).toBe(VALID_CANVAS);
    expect((await runCli(["show", version.id, "--source", ...common])).stdout).toBe(VALID_CANVAS);
    const reopened = await runCli(["open", "--version", version.id, "--event", eventId, ...common, "--no-open"], { HERDR_CANVAS_SERVER_URL: server.url });
    expect(reopened.exitCode).toBe(0);
    const url = JSON.parse(reopened.stdout).url;
    expect(url).toBe(`${server.url}/v/${version.id}?event=${eventId}`);
    expect((await fetch(url)).status).toBe(200);
    const ambiguous = await runCli(["open", "overview", "--version", version.id, ...common]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("but not both");
    const restored = await runCli(["restore", version.id, ...common]);
    expect(restored.exitCode).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ restored: true, revision: 2 });
    expect(readFileSync(path, "utf8")).toBe(VALID_CANVAS);
  } finally { server.stop(); }
}, { timeout: 30_000 });

test("CLI and MCP read/edit share range, batch, stale-source and diagnostic contracts", async () => {
  const cliDir = tempDir();
  const mcpDir = tempDir();
  writeCanvas(cliDir, "overview", VALID_CANVAS);
  writeCanvas(mcpDir, "overview", VALID_CANVAS);
  const service = new CanvasService({ canvasesDir: mcpDir, env: { HERDR_CANVAS_HISTORY_DB: join(mcpDir, "history.sqlite") } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { name: "overview", ...args } } }, service);
    return response!;
  };
  const payload = (response: Awaited<ReturnType<typeof call>>) => JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text);
  const cliRead = await runCli(["read", "overview", "--start-line", "5", "--end-line", "7", "--dir", cliDir]);
  const mcpRead = payload(await call("canvas_read", { start_line: 5, end_line: 7 }));
  const cliSource = JSON.parse(cliRead.stdout);
  expect(cliRead.exitCode).toBe(0);
  expect({ ...cliSource, path: undefined }).toEqual({ ...mcpRead, path: undefined });
  const edit = { edits: [{ old_text: "<H1>Overview</H1>", new_text: "<H1>Edited</H1>" }], expected_hash: cliSource.source_hash };
  const cliEdit = await runCli(["edit", "overview", "--stdin", "--dir", cliDir], {}, JSON.stringify(edit));
  const mcpEdit = await call("canvas_edit", edit);
  expect(cliEdit.exitCode).toBe(0);
  expect({ ...JSON.parse(cliEdit.stdout), path: undefined }).toEqual({ ...payload(mcpEdit), path: undefined });
  expect(JSON.parse(cliEdit.stdout)).not.toHaveProperty("source");
  expect((await runCli(["edit", "overview", "--stdin", "--dir", cliDir], {}, JSON.stringify(edit))).exitCode).toBe(1);
  expect((await call("canvas_edit", edit)).error?.message).toContain("changed since read");
  const bad = { edits: [{ old_text: "gap={16}", new_text: 'gap="wide"' }] };
  const editsPath = join(cliDir, "edits.json");
  await Bun.write(editsPath, JSON.stringify(bad));
  const cliBad = await runCli(["edit", "overview", "--file", editsPath, "--dir", cliDir]);
  const mcpBad = await call("canvas_edit", bad);
  expect(cliBad.exitCode).toBe(1);
  expect(JSON.parse(cliBad.stdout)).toMatchObject({ ok: false, applied: true });
  expect(mcpBad.result).toMatchObject({ isError: true });
  expect(payload(mcpBad)).toMatchObject({ ok: false, applied: true });
  expect(service.read("overview")).toBe(readFileSync(join(cliDir, "overview.canvas.tsx"), "utf8"));
  expect((await runCli(["read", "overview", "--start-line", "--dir", cliDir])).exitCode).toBe(1);
  expect((await call("canvas_read", { start_line: "5" })).error).toBeDefined();
  expect((await call("canvas_edit", { edits: [{ old_text: "Edited", new_text: null }] })).error).toBeDefined();
  expect((await runCli(["edit", "overview", "--stdin", "--dir", cliDir], {}, "null")).exitCode).toBe(1);
}, { timeout: 60_000 });

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn([process.execPath, join(PLUGIN_ROOT, "src/cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const stdout = await new Response(subprocess.stdout).text();
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;
  return { exitCode, stdout, stderr };
}
