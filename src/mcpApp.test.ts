import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CANVAS_APP_URI, CANVAS_APP_MIME, canvasAppResult } from "./mcpApp";
import { handleMcpRequest } from "./mcp";
import { CanvasHistory } from "./history";
import { CanvasService } from "./service";
import { tempDir, VALID_CANVAS, writeCanvas } from "./test/fixtures";

function fixture() {
  const dir = tempDir();
  const db = join(dir, "history.sqlite");
  const panes: string[][] = [];
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: db }, herdr: {
    bin: "herdr", run(args) { panes.push(args); return { status: 0, stdout: "{}", stderr: "" }; },
  } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, service);
    if (response?.error) throw new Error(response.error.message);
    return response!.result as { content: Array<{ type: string; text: string }>; isError: boolean; structuredContent: Record<string, any>; _meta?: { canvas?: { js: string; name: string; versionId: string; state: Record<string, unknown> } } };
  };
  return { dir, db, panes, service, call };
}

test("create, show, edit and restore deliver the actual canvas without opening Herdr", async () => {
  const { call, panes, service } = fixture();
  const created = await call("canvas_write", { name: "overview", contents: VALID_CANVAS, open: true });
  expect(created.isError).toBe(false);
  expect(created._meta?.canvas?.js).toContain("Embedded sample data.");
  expect(created.content[0]?.text).not.toContain("createRoot");
  expect(created.structuredContent).not.toHaveProperty("_meta");
  const versionId = created._meta!.canvas!.versionId;
  const shown = await call("canvas_open", { name: "overview" });
  expect(shown._meta?.canvas?.versionId).toBe(versionId);
  const edited = await call("canvas_edit", { name: "overview", edits: [{ old_text: "Embedded sample data.", new_text: "Updated inline." }] });
  expect(edited._meta?.canvas?.js).toContain("Updated inline.");
  expect(edited.structuredContent.applied).toBe(true);
  const restored = await call("canvas_restore", { version_id: versionId });
  expect(restored.isError).toBe(false);
  expect(restored._meta?.canvas?.js).toContain("Embedded sample data.");
  expect(service.read("overview")).toBe(VALID_CANVAS);
  expect(panes).toEqual([]);
});

test("failed writes and edits retain diagnostics and applied source without executable preview", async () => {
  const { call, service } = fixture();
  const invalid = VALID_CANVAS.replace("gap={16}", 'gap="invalid"');
  const written = await call("canvas_write", { name: "overview", contents: invalid });
  expect(written.isError).toBe(true);
  expect(written._meta).toBeUndefined();
  expect(written.structuredContent.diagnostics.length).toBeGreaterThan(0);
  expect(service.read("overview")).toBe(invalid);
  await call("canvas_write", { name: "overview", contents: VALID_CANVAS });
  const edited = await call("canvas_edit", { name: "overview", edits: [{ old_text: "gap={16}", new_text: 'gap="invalid"' }] });
  expect(edited.isError).toBe(true);
  expect(edited.structuredContent.applied).toBe(true);
  expect(edited._meta).toBeUndefined();
});

test("archive previews use selected event state, raw source, and workspace isolation", async () => {
  const { dir, db, service } = fixture();
  const history = new CanvasHistory(db);
  const saved = history.capture({ workspace: dir, name: "gone", sourcePath: join(dir, "gone.canvas.tsx"), source: VALID_CANVAS, runtime: "test" });
  const event = history.served(saved.id, { count: 7 }, "live");
  history.served(saved.id, { count: 9 }, "live");
  history.close();
  const result = await canvasAppResult(service, { version_id: saved.id, event_id: event });
  expect(result._meta?.canvas.state).toEqual({ count: 7 });
  expect(result._meta?.canvas.js).toContain("Embedded sample data.");
  expect((await canvasAppResult(service, { version_id: saved.id }))._meta?.canvas.state).toEqual({ count: 9 });
  await expect(canvasAppResult(service, { version_id: saved.id, event_id: "missing" })).rejects.toThrow("serve event not found");
  const foreign = new CanvasService({ canvasesDir: tempDir(), env: { HERDR_CANVAS_HISTORY_DB: db } });
  await expect(canvasAppResult(foreign, { version_id: saved.id })).rejects.toThrow("version not found in this workspace");
});

test("working preview initializes from sidecar without modifying it and rejects invalid selections", async () => {
  const { dir, service } = fixture();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const statePath = path.replace(".canvas.tsx", ".canvas.data.json");
  writeFileSync(statePath, '{"count":3}');
  expect((await canvasAppResult(service, { name: "overview" }))._meta?.canvas.state).toEqual({ count: 3 });
  expect(readFileSync(statePath, "utf8")).toBe('{"count":3}');
  for (const selection of [{}, { name: "overview", version_id: "x" }, { name: "overview", event_id: "x" }, { name: "../overview" }, { name: "missing" }]) {
    await expect(canvasAppResult(service, selection)).rejects.toThrow();
  }
  symlinkSync(path, join(dir, "linked.canvas.tsx"));
  await expect(canvasAppResult(service, { name: "linked" })).rejects.toThrow();
});

test("official MCP client can initialize, discover UI, create and show over standard stdio", async () => {
  const dir = tempDir();
  const client = new Client({ name: "canvas-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "cli.ts"), "mcp", "--dir", dir, "--history-db", join(dir, "history.sqlite")],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const tools = await client.listTools();
    for (const name of ["canvas_write", "canvas_open", "canvas_edit", "canvas_restore"]) {
      expect(tools.tools.find(tool => tool.name === name)?._meta).toMatchObject({ ui: { resourceUri: CANVAS_APP_URI } });
    }
    expect(tools.tools.find(tool => tool.name === "canvas_list")?._meta).toBeUndefined();
    const resources = await client.listResources();
    expect(resources.resources[0]?.mimeType).toBe(CANVAS_APP_MIME);
    const resource = await client.readResource({ uri: CANVAS_APP_URI });
    expect(resource.contents[0]?.mimeType).toBe(CANVAS_APP_MIME);
    expect(resource.contents[0]).toHaveProperty("text");
    const created = await client.callTool({ name: "canvas_write", arguments: { name: "overview", contents: VALID_CANVAS } });
    expect(created.isError).toBe(false);
    expect(created._meta).toHaveProperty("canvas");
    const shown = await client.callTool({ name: "canvas_open", arguments: { name: "overview" } });
    expect(shown.isError).toBe(false);
    expect(shown._meta).toHaveProperty("canvas");
    await expect(client.readResource({ uri: "ui://canvas/missing" })).rejects.toThrow("unknown resource");
  } finally { await client.close(); }
});
