import { expect, test } from "bun:test";
import { ArtifactService } from "../service";
import { tempDir, VALID_ARTIFACT } from "../test/fixtures";
import { join } from "node:path";
import { handleMcpRequest } from "./local-tools";
import { artifactResourceUri } from "./workspace-contract";
import { localResource, localWorkspace } from "./local-workspace";

function fixture() {
  const dir = tempDir();
  const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: join(dir, "history.sqlite") } });
  const request = (method: string, params: unknown) => handleMcpRequest({ jsonrpc: "2.0", id: 1, method, params }, service);
  return { dir, service, request };
}

test("library entrypoints accept empty args and mention resources stay in the connected workspace", async () => {
  const { dir, service, request } = fixture();
  service.write("revenue", VALID_ARTIFACT);
  const response = await request("tools/call", { name: "artifacts_library", arguments: {} });
  expect(response?.result).toMatchObject({ _meta: { workspace: { view: "library", items: [{ name: "revenue", workspace: dir, working: true }], gallery: { capabilities: { editing: false } } } } });
  const mentions = (await request("tools/call", { name: "artifacts_mentions", arguments: { query: "reven" } }))?.result as { structuredContent: { items: { uri: string }[] } };
  const uri = mentions.structuredContent.items[0]!.uri;
  expect(localResource(service, uri)).toMatchObject({ name: "revenue", source: VALID_ARTIFACT });
  expect(() => localResource(service, artifactResourceUri({ workspace: tempDir(), name: "revenue" }))).toThrow("outside this workspace");
  expect(localWorkspace(service, "working", "missing").items).toEqual([]);
});

test("preview suppression saves compiled source history without recording a delivery", async () => {
  const { service, request } = fixture();
  const response = await request("tools/call", { name: "artifact_write", arguments: { name: "quiet", contents: VALID_ARTIFACT, preview: false } });
  expect(response?.result).toMatchObject({ isError: false });
  expect(response?.result).not.toHaveProperty("_meta");
  const history = service.history("quiet");
  expect(history).toHaveLength(1);
  expect(history[0]?.serve_count).toBe(0);
  const opened = await request("tools/call", { name: "artifacts_preview", arguments: { version_id: history[0]!.version_id } });
  expect(opened?.result).toHaveProperty("_meta.artifact.js");
  expect(service.history("quiet")[0]?.serve_count).toBe(1);
});

test("text clients keep model workflows without UI entrypoints or executable preview payloads", async () => {
  const { request } = fixture();
  await request("initialize", { capabilities: {} });
  const response = (await request("tools/list", {}))?.result as { tools: { name: string; _meta?: unknown }[] };
  expect(response.tools.some(tool => tool.name === "artifact_write")).toBe(true);
  expect(response.tools.some(tool => tool.name === "artifacts_library")).toBe(false);
  expect(response.tools.every(tool => tool._meta === undefined)).toBe(true);
  const written = await request("tools/call", { name: "artifact_write", arguments: { name: "plain", contents: VALID_ARTIFACT } });
  expect(written?.result).toMatchObject({ isError: false, structuredContent: { ok: true } });
  expect(written?.result).not.toHaveProperty("_meta");
});

test("file entrypoint validates an opaque envelope without resolving it on the server", async () => {
  const { request } = fixture();
  const file = { name: "revenue.artifact.tsx", resourceUri: "host-owned:opaque-token" };
  expect((await request("tools/call", { name: "artifacts_file", arguments: { file } }))?.result).toMatchObject({ structuredContent: { file } });
  expect((await request("tools/call", { name: "artifacts_file", arguments: { file: { ...file, name: "ordinary.tsx" } } }))?.error).toBeDefined();
  expect((await request("tools/call", { name: "artifacts_file", arguments: { file: { ...file, resourceUri: " " } } }))?.error).toBeDefined();
});
