import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CanvasService } from "./service";
import { createCanvasServer } from "./serve";
import { handleMcpRequest } from "./mcp/local-tools";
import { VALID_CANVAS, tempDir } from "./test/fixtures";

function setup() {
  const dir = tempDir();
  const db = join(dir, "history.sqlite");
  const service = new CanvasService({ cwd: dir, canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: db } });
  writeFileSync(join(dir, "source.canvas.tsx"), VALID_CANVAS);
  return { dir, db, service };
}

test("remix copies working source with durable provenance and fresh state", () => {
  const { dir, service } = setup();
  writeFileSync(join(dir, "source.canvas.data.json"), '{"secret":"private"}');
  const result = service.remix({ name: "source", new_name: "copy" });
  expect(result.ok).toBe(true);
  expect(readFileSync(result.path, "utf8")).toBe(VALID_CANVAS);
  expect(existsSync(join(dir, "copy.canvas.data.json"))).toBe(false);
  const version = service.version(result.versionId);
  expect(version.origin).toMatchObject({ source_name: "source", source_version_id: service.history("source")[0]!.version_id });
  expect(version.events).toEqual([]);
  expect(version.artifact_id).not.toBe(service.history("source")[0]!.artifact_id);
  expect(service.history("copy")[0]!.reason).toBe("remix");
});

test("archived remix copies selected revision even after source is deleted", () => {
  const { dir, service } = setup();
  service.remix({ name: "source", new_name: "first" });
  const versionId = service.history("source")[0]!.version_id;
  unlinkSync(join(dir, "source.canvas.tsx"));
  const result = service.remix({ version_id: versionId, new_name: "second" });
  expect(readFileSync(result.path, "utf8")).toBe(VALID_CANVAS);
  expect(service.version(result.versionId).origin).toMatchObject({ source_version_id: versionId });
  expect(() => service.remix({ version_id: versionId, new_name: "source" })).toThrow("history");
});

test("remix rejects collisions, links, orphan state, traversal and ambiguous sources", () => {
  const { dir, service } = setup();
  for (const input of [{ new_name: "copy" }, { name: "source", version_id: "id", new_name: "copy" }]) {
    expect(() => service.remix(input)).toThrow("provide name or version_id");
  }
  expect(() => service.remix({ name: "../source", new_name: "copy" })).toThrow("slashes");
  expect(() => service.remix({ name: "source", new_name: "../copy" })).toThrow("slashes");
  expect(() => service.remix({ name: "source", new_name: "source" })).toThrow("exists");
  symlinkSync(join(dir, "missing"), join(dir, "copy.canvas.tsx"));
  expect(() => service.remix({ name: "source", new_name: "copy" })).toThrow("exists");
  symlinkSync(join(dir, "source.canvas.tsx"), join(dir, "link.canvas.tsx"));
  expect(() => service.remix({ name: "link", new_name: "new" })).toThrow("symlink");
  writeFileSync(join(dir, "orphan.canvas.data.json"), '{}');
  expect(() => service.remix({ name: "source", new_name: "orphan" })).toThrow("exists");
  expect(service.history()).toEqual([]);
});

test("CLI remixes working and archived sources; local MCP validates the same contract", async () => {
  const { dir, db, service } = setup();
  for (const args of [["source", "cli-copy"], ["archived-copy", "--version", "VERSION"]]) {
    if (args.includes("VERSION")) args[args.indexOf("VERSION")] = service.history("source")[0]!.version_id;
    const child = Bun.spawn([process.execPath, "src/cli.ts", "remix", ...args, "--dir", dir, "--history-db", db], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    expect({ code: await child.exited, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out).remixed).toBe(true);
  }
  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_remix", arguments: { name: "source", version_id: "bad", new_name: "mcp-copy" } } }, service);
  expect(response?.error?.message).toContain("provide name or version_id");
}, 120_000);

test("gallery remix requires same-origin JSON and creates a distinct artifact", async () => {
  const { dir, db } = setup();
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: db, gallery: true });
  try {
    const body = JSON.stringify({ name: "canvas_remix", arguments: { name: "source", new_name: "web-copy" } });
    const rejected = await fetch(server.url + "/api/tools", { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" }, body });
    expect(rejected.status).toBe(403);
    const rebound = await fetch(server.url + "/api/tools", { method: "POST", headers: { "content-type": "application/json", host: "untrusted.example", origin: "http://untrusted.example" }, body });
    expect(rebound.status).toBe(403);
    expect(existsSync(join(dir, "web-copy.canvas.tsx"))).toBe(false);
    const accepted = await fetch(server.url + "/api/tools", { method: "POST", headers: { "content-type": "application/json", origin: server.url }, body });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, remixed: true, name: "web-copy" });
  } finally { server.stop(); }
});
