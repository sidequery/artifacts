import { expect, test } from "bun:test";
import Ajv from "ajv";
import { CLOUD_MCP_TOOLS } from "./tool-contract";
import { galleryAction, gallerySource } from "./gallery-tools";
import { toolErrorResult } from "../src/mcp/tool-result";
import { settingsTool } from "../src/mcp/settings-contract";

test("gallery source returns complete projects and selects the requested kind and workspace", async () => {
  const source = Array.from({ length: 250 }, (_, index) => `// line ${index}\n`).join("");
  const project = { files: { "helper.ts": "export const value = 1;" }, dependencies: { example: "1.0.0" }, lock: { "node_modules/example/index.js": "export const dependency = 2;" } };
  const calls: unknown[] = [];
  const service = {
    async snapshot(selection: unknown) { calls.push(["artifact", selection]); return { name: "example", source, server_source: "server", project, revision_token: "artifact-revision" }; },
    async scriptReadSource(selection: unknown) { calls.push(["script", selection]); return { name: "example", source, project, revision_token: "script-revision" }; },
  };
  for (const kind of ["artifact", "script"]) {
    const result = await gallerySource(service, { workspace: "research", kind, version_id: "historical" });
    expect(result.structuredContent).toEqual({ name: "example", kind, workspace: "research", source, server_source: kind === "artifact" ? "server" : null, project, revision_token: `${kind}-revision` });
  }
  expect(calls).toEqual([["artifact", { workspace: "research", version_id: "historical" }], ["script", { workspace: "research", version_id: "historical" }]]);
  await expect(gallerySource(service, { workspace: "research", kind: "artifact", name: "example", version_id: "historical" })).rejects.toThrow("not both");
});

test("gallery action preserves CAS failures and committed validation diagnostics", async () => {
  const calls: unknown[] = [];
  const service = { async callTool(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (args.expected_revision === "stale") throw new Error("Project changed since it was loaded. Reload the saved project or compare it with your edits before saving.");
    const payload = { applied: true, ok: false, revision_token: "new-revision", diagnostics: [{ message: "Invalid source", severity: "error" }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  } };
  const failed = await galleryAction(service, { workspace: "research", tool: "artifact_write", arguments: { name: "example", contents: "invalid", expected_revision: "current" } });
  expect(failed).toMatchObject({ isError: true, structuredContent: { applied: true, revision_token: "new-revision", diagnostics: [{ message: "Invalid source" }] } });
  const conflict = await galleryAction(service, { workspace: "research", tool: "script_write", arguments: { name: "example", contents: "new", expected_revision: "stale" } });
  expect(conflict).toMatchObject({ isError: true, structuredContent: { status: 409, conflict: true, applied: false } });
  expect(calls).toEqual([
    { name: "artifact_write", args: { workspace: "research", name: "example", contents: "invalid", expected_revision: "current" } },
    { name: "script_write", args: { workspace: "research", name: "example", contents: "new", expected_revision: "stale" } },
  ]);
  await expect(galleryAction(service, { workspace: "research", tool: "app_write", arguments: {} })).rejects.toThrow("Unsupported");
  await expect(galleryAction(service, { workspace: "research", tool: "artifact_write", arguments: { workspace: "elsewhere" } })).rejects.toThrow("envelope");
  expect(toolErrorResult(Object.assign(new Error("storage failed after save"), { status: 503, applied: true, revision_token: "saved" }))).toMatchObject({ structuredContent: { status: 503, applied: true, revision_token: "saved" } });
});

test("published gallery proxy validates underlying tool schemas without granting blanket app visibility", () => {
  const tool = CLOUD_MCP_TOOLS.find(tool => tool.name === "artifacts_tool")!;
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  expect(validate({ workspace: "research", tool: "artifact_write", arguments: { name: "example", contents: "source", expected_revision: null, project: { files: {}, dependencies: {} } } })).toBe(true);
  for (const argumentsValue of [{ name: "example" }, { name: "example", contents: "source", workspace: "wrong" }, { name: "example", contents: "source", expected_revision: 3 }, { name: "example", contents: "source", project: { unexpected: "value" } }]) {
    expect(validate({ workspace: "research", tool: "artifact_write", arguments: argumentsValue })).toBe(false);
  }
  expect(validate({ workspace: "research", tool: "app_write", arguments: {} })).toBe(false);
  expect(tool._meta?.ui).toEqual({ visibility: ["app"] });
  expect((CLOUD_MCP_TOOLS.find(tool => tool.name === "artifact_write")!._meta?.ui as { visibility: string[] }).visibility).toEqual(["model"]);
  const source = CLOUD_MCP_TOOLS.find(tool => tool.name === "artifacts_source")!;
  const validateSource = new Ajv({ strict: false }).compile(source.inputSchema);
  expect(validateSource({ workspace: "research", kind: "script", version_id: "historical" })).toBe(true);
  expect(validateSource({ workspace: "research", kind: "script", version_id: "historical", name: "example" })).toBe(false);
});

test("native connection settings describe the real connection and check authorized access", async () => {
  let reads = 0;
  const service = { workspace: "research", productUrl: "https://artifacts.example/?workspace=research", async gallery(all: boolean) {
    expect(all).toBe(true); reads++;
    return { workspace: "research", artifacts: [], capabilities: { editing: true, scripts: true } };
  } };
  const settings = await settingsTool(service, "artifacts_settings_read", {});
  expect(settings.structuredContent).toMatchObject({ schema: { properties: {} }, values: {}, layout: [{ title: "Workspace: research", items: [{ tool: "artifacts_connection_check", description: expect.stringContaining(service.productUrl) }] }] });
  expect(reads).toBe(0);
  expect(await settingsTool(service, "artifacts_connection_check", {})).toMatchObject({ structuredContent: { ok: true, workspace: "research", productUrl: service.productUrl, capabilities: { editing: true, scripts: true } } });
  expect(reads).toBe(1);
  await expect(settingsTool(service, "artifacts_settings_update", { set: { workspace: "wrong" } })).rejects.toThrow("managed by the MCP host");
});
