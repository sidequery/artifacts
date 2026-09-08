import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { compileCanvas } from "./compile";
import { CanvasService } from "./service";
import { CanvasHistory } from "./history";
import { readLocalProject, writeLocalProject } from "./localProject";
import { tempDir, writeCanvas } from "./test/fixtures";
import { emptyProject } from "../cloudflare/project";

const source = `import { Text } from "sidequery/canvas";
import { label } from "./helpers/label";
export default function Canvas() { return <Text>{label}</Text>; }`;
const project = { files: { "helpers/label.ts": 'import { value } from "tiny-fixture"; export const label = value;' }, dependencies: { "tiny-fixture": "1.0.0" }, lock: {
  "node_modules/tiny-fixture/package.json": '{"name":"tiny-fixture","version":"1.0.0","main":"index.js","types":"index.d.ts"}',
  "node_modules/tiny-fixture/index.js": 'export const value = "locked-original";',
  "node_modules/tiny-fixture/index.d.ts": 'export declare const value: string;',
} };

test("local project bundles locked packages and rejects helper escapes and forbidden APIs", async () => {
  const path = writeCanvas(tempDir(), "project", source);
  writeLocalProject(path, project);
  const compiled = await compileCanvas(path);
  expect(compiled.ok).toBe(true); expect(compiled.js).toContain("locked-original");
  writeLocalProject(path, { ...project, files: { "helpers/label.ts": 'export const label = fetch("https://example.com");' } });
  expect((await compileCanvas(path)).diagnostics.some(item => item.message.includes("fetch()"))).toBe(true);
  writeLocalProject(path, { ...project, files: { "helpers/label.ts": 'export { label } from "../../outside";' } });
  expect((await compileCanvas(path)).ok).toBe(false);
});

test("project changes create revisions, replay uses snapshot, restore and remix preserve dependencies", async () => {
  const dir = tempDir(), path = writeCanvas(dir, "project", source), db = join(dir, "history.sqlite");
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: db } });
  const history = new CanvasHistory(db);
  try {
    writeLocalProject(path, project);
    const input = { workspace: dir, name: "project", sourcePath: path, source, runtime: "test" };
    const original = history.capture(input);
    writeLocalProject(path, { ...project, files: { "helpers/label.ts": 'export const label = "changed";' } });
    expect(history.capture(input).id).not.toBe(original.id);
    const replay = await compileCanvas(path, original.source, undefined, original.project);
    expect(replay.js).toContain("locked-original"); expect(replay.js).not.toContain('label = "changed"');
    expect(service.restore(original.id).ok).toBe(true);
    expect(readLocalProject(path)).toEqual(project);
    expect(service.remix({ version_id: original.id, new_name: "copy" }).ok).toBe(true);
    expect(readLocalProject(join(dir, "copy.canvas.tsx"))).toEqual(project);
    expect((await service.compile("copy")).js).toContain("locked-original");
    service.edit("copy", [{ old_text: "function Canvas", new_text: "function Copy" }]);
    expect(service.readRange("copy").project).toEqual(project);
    const old = history.capture({ ...input, name: "legacy", sourcePath: join(dir, "legacy.canvas.tsx"), project: emptyProject() });
    expect(old.project).toEqual(emptyProject());
  } finally { history.close(); }
}, 180_000);

test("CLI authors helper modules and MCP writes preserve a resolved dependency snapshot", async () => {
  const dir = tempDir(), input = join(dir, "source.txt"), projectFile = join(dir, "project.json");
  writeFileSync(input, source);
  writeFileSync(projectFile, JSON.stringify({ files: { "helpers/label.ts": 'export const label = "CLI helper";' }, dependencies: {} }));
  const cli = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "write", "cli-project", "--dir", dir, "--file", input, "--project", projectFile], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0); expect(JSON.parse(output).ok).toBe(true);
  expect(readLocalProject(join(dir, "cli-project.canvas.tsx")).files["helpers/label.ts"]).toContain("CLI helper");
  const { handleMcpRequest } = await import("./mcp/local-tools");
  const path = writeCanvas(dir, "mcp-project", source); writeLocalProject(path, project);
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: join(dir, "history.sqlite") } });
  // Same pinned dependencies reuse the existing lock without consulting the registry.
  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_write", arguments: { name: "mcp-project", contents: source, project: { files: project.files, dependencies: project.dependencies } } } }, service);
  expect(response?.error).toBeUndefined();
  expect(readLocalProject(path)).toEqual(project);
  expect((await compileCanvas(path)).js).toContain("locked-original");
}, 180_000);

test("helper read/edit guards exact file hashes and CLI/MCP select helper paths", async () => {
  const dir = tempDir(), path = writeCanvas(dir, "project", source);
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: join(dir, "history.sqlite") } });
  writeLocalProject(path, project);
  const read = service.readRange("project", { file: "helpers/label.ts" });
  expect(read.source).toBe(project.files["helpers/label.ts"]);
  expect(() => service.readRange("project", { file: "../outside.ts" })).toThrow("project file not found");
  const changed = service.edit("project", [{ old_text: "label = value", new_text: 'label = value + " edited"' }], read.source_hash, "helpers/label.ts");
  expect(changed.ok).toBe(true);
  expect(() => service.edit("project", [{ old_text: "edited", new_text: "stale" }], read.source_hash, "helpers/label.ts")).toThrow("changed since read");
  expect(service.read("project")).toBe(source);
  expect(readLocalProject(path).lock).toEqual(project.lock);
  const patch = join(dir, "patch.json");
  writeFileSync(patch, JSON.stringify({ edits: [{ old_text: " edited", new_text: " CLI" }] }));
  const cli = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "edit", "project", "--dir", dir, "--source-file", "helpers/label.ts", "--file", patch], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0); expect(JSON.parse(output).ok).toBe(true);
  const { handleMcpRequest } = await import("./mcp/local-tools");
  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_read", arguments: { name: "project", file: "helpers/label.ts" } } }, service);
  expect(JSON.stringify(response)).toContain("CLI");
  expect(JSON.stringify(response)).not.toContain("export default function Canvas");
  const edited = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canvas_edit", arguments: { name: "project", file: "helpers/label.ts", edits: [{ old_text: " CLI", new_text: " MCP" }] } } }, service);
  expect(edited?.error).toBeUndefined();
  expect(service.readRange("project", { file: "helpers/label.ts" }).source).toContain(" MCP");
}, 180_000);

test("archived inline MCP previews compile the archived dependency lock after working files are deleted", async () => {
  const dir = tempDir(), path = writeCanvas(dir, "project", source), db = join(dir, "history.sqlite");
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: db } });
  writeLocalProject(path, project);
  const { canvasAppResult } = await import("./mcp/app");
  const initial = await canvasAppResult(service, { name: "project" });
  expect(initial.ok).toBe(true);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(path); unlinkSync(path + ".project.json");
  const replay = await canvasAppResult(service, { version_id: initial.canvas!.versionId });
  expect(replay.ok).toBe(true);
  expect(replay._meta!.canvas.js).toContain("locked-original");
}, 180_000);
