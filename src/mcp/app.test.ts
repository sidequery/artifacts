import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ARTIFACTS_APP_URI, ARTIFACTS_APP_MIME, artifactAppResult } from "./app";
import { handleMcpRequest } from "./local-tools";
import { ArtifactHistory } from "../history";
import { ArtifactService } from "../service";
import { tempDir, VALID_ARTIFACT, writeArtifact } from "../test/fixtures";

function fixture() {
  const dir = tempDir();
  const db = join(dir, "history.sqlite");
  const panes: string[][] = [];
  const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: db }, herdr: {
    bin: "herdr", run(args) { panes.push(args); return { status: 0, stdout: "{}", stderr: "" }; },
  } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, service);
    if (response?.error) throw new Error(response.error.message);
    return response!.result as { content: Array<{ type: string; text: string }>; isError: boolean; structuredContent: Record<string, any>; _meta?: { artifact?: { js: string; name: string; versionId: string; state: Record<string, unknown> } } };
  };
  return { dir, db, panes, service, call };
}

test("create, show, edit and restore deliver the actual artifact without opening Herdr", async () => {
  const { call, panes, service } = fixture();
  const created = await call("artifact_write", { name: "overview", contents: VALID_ARTIFACT, open: true });
  expect(created.isError).toBe(false);
  expect(created._meta?.artifact?.js).toContain("Embedded sample data.");
  expect(created.content[0]?.text).not.toContain("createRoot");
  expect(created.structuredContent).not.toHaveProperty("_meta");
  const versionId = created._meta!.artifact!.versionId;
  const shown = await call("artifact_open", { name: "overview" });
  expect(shown._meta?.artifact?.versionId).toBe(versionId);
  const edited = await call("artifact_edit", { name: "overview", edits: [{ old_text: "Embedded sample data.", new_text: "Updated inline." }] });
  expect(edited._meta?.artifact?.js).toContain("Updated inline.");
  expect(edited.structuredContent.applied).toBe(true);
  const restored = await call("artifact_restore", { version_id: versionId });
  expect(restored.isError).toBe(false);
  expect(restored._meta?.artifact?.js).toContain("Embedded sample data.");
  expect(service.read("overview")).toBe(VALID_ARTIFACT);
  expect(panes).toEqual([]);
});

test("failed writes and edits retain diagnostics and applied source without executable preview", async () => {
  const { call, service } = fixture();
  const invalid = VALID_ARTIFACT.replace("gap={16}", 'gap="invalid"');
  const written = await call("artifact_write", { name: "overview", contents: invalid });
  expect(written.isError).toBe(true);
  expect(written._meta).toBeUndefined();
  expect(written.structuredContent.diagnostics.length).toBeGreaterThan(0);
  expect(service.read("overview")).toBe(invalid);
  await call("artifact_write", { name: "overview", contents: VALID_ARTIFACT });
  const edited = await call("artifact_edit", { name: "overview", edits: [{ old_text: "gap={16}", new_text: 'gap="invalid"' }] });
  expect(edited.isError).toBe(true);
  expect(edited.structuredContent.applied).toBe(true);
  expect(edited._meta).toBeUndefined();
});

test("archive previews use selected event state, raw source, and workspace isolation", async () => {
  const { dir, db, service } = fixture();
  const history = new ArtifactHistory(db);
  const saved = history.capture({ workspace: dir, name: "gone", sourcePath: join(dir, "gone.artifact.tsx"), source: VALID_ARTIFACT, runtime: "test" });
  const event = history.served(saved.id, { count: 7 }, "live");
  history.served(saved.id, { count: 9 }, "live");
  history.close();
  const result = await artifactAppResult(service, { version_id: saved.id, event_id: event });
  expect(result._meta?.artifact.state).toEqual({ count: 7 });
  expect(result._meta?.artifact.js).toContain("Embedded sample data.");
  expect((await artifactAppResult(service, { version_id: saved.id }))._meta?.artifact.state).toEqual({ count: 9 });
  await expect(artifactAppResult(service, { version_id: saved.id, event_id: "missing" })).rejects.toThrow("serve event not found");
  const foreign = new ArtifactService({ artifactsDir: tempDir(), env: { ARTIFACTS_HISTORY_DB: db } });
  await expect(artifactAppResult(foreign, { version_id: saved.id })).rejects.toThrow("version not found in this workspace");
});

test("working preview initializes from sidecar without modifying it and rejects invalid selections", async () => {
  const { dir, service } = fixture();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const statePath = path.replace(".artifact.tsx", ".artifact.data.json");
  writeFileSync(statePath, '{"count":3}');
  expect((await artifactAppResult(service, { name: "overview" }))._meta?.artifact.state).toEqual({ count: 3 });
  expect(readFileSync(statePath, "utf8")).toBe('{"count":3}');
  for (const selection of [{}, { name: "overview", version_id: "x" }, { name: "overview", event_id: "x" }, { name: "../overview" }, { name: "missing" }]) {
    await expect(artifactAppResult(service, selection)).rejects.toThrow();
  }
  symlinkSync(path, join(dir, "linked.artifact.tsx"));
  await expect(artifactAppResult(service, { name: "linked" })).rejects.toThrow();
});

test("official MCP client can initialize, discover UI, create and show over standard stdio", async () => {
  const dir = tempDir();
  const client = new Client({ name: "artifact-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "../cli.ts"), "mcp", "--dir", dir, "--history-db", join(dir, "history.sqlite")],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const tools = await client.listTools();
    for (const name of ["artifact_write", "artifact_open", "artifact_edit", "artifact_restore"]) {
      expect(tools.tools.find(tool => tool.name === name)?._meta).toMatchObject({ ui: { resourceUri: ARTIFACTS_APP_URI } });
    }
    expect(tools.tools.find(tool => tool.name === "artifact_list")?._meta).toBeUndefined();
    const resources = await client.listResources();
    expect(resources.resources[0]?.mimeType).toBe(ARTIFACTS_APP_MIME);
    const resource = await client.readResource({ uri: ARTIFACTS_APP_URI });
    expect(resource.contents[0]?.mimeType).toBe(ARTIFACTS_APP_MIME);
    expect(resource.contents[0]).toHaveProperty("text");
    const created = await client.callTool({ name: "artifact_write", arguments: { name: "overview", contents: VALID_ARTIFACT } });
    expect(created.isError).toBe(false);
    expect(created._meta).toHaveProperty("artifact");
    const shown = await client.callTool({ name: "artifact_open", arguments: { name: "overview" } });
    expect(shown.isError).toBe(false);
    expect(shown._meta).toHaveProperty("artifact");
    await expect(client.readResource({ uri: "ui://artifacts/missing" })).rejects.toThrow("unknown resource");
  } finally { await client.close(); }
});
