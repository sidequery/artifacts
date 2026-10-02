import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { ArtifactService } from "./service";
import { parseProjectArchive, projectArchive } from "./project-archive";
import { localProjectPath, localServerPath } from "./localProject";
import { VALID_ARTIFACT, tempDir } from "./test/fixtures";

const serverSource = 'import { DurableObject } from "cloudflare:workers"; export class ArtifactServer extends DurableObject { fetch() { return Response.json({ok:true}); } }';
const project = { files: { "lib/value.ts": 'export {value} from "archive-value";' }, dependencies: { "archive-value": "1.0.0" }, lock: {
  "node_modules/archive-value/package.json": '{"name":"archive-value","version":"1.0.0","main":"index.js","types":"index.d.ts"}',
  "node_modules/archive-value/index.js": "export const value = 7;",
  "node_modules/archive-value/index.d.ts": "export const value: number;",
} };

test("archives validate version, source limits, complete snapshots and safe paths", () => {
  const archive = projectArchive("artifact", { name: "portable", source: VALID_ARTIFACT, server_source: serverSource, project });
  expect(parseProjectArchive(JSON.parse(JSON.stringify(archive)))).toEqual(archive);
  for (const extra of [{ state: {} }, { secrets: {} }, { access: "public" }]) expect(() => parseProjectArchive({ ...archive, ...extra })).toThrow("archive fields");
  expect(() => parseProjectArchive({ ...archive, version: 2 })).toThrow("Unsupported");
  expect(() => parseProjectArchive({ ...archive, source: "x".repeat(256 * 1024 + 1) })).toThrow("256 KiB");
  expect(() => parseProjectArchive({ ...archive, kind: "script" })).toThrow("server source");
  expect(() => parseProjectArchive({ ...archive, project: { files: {}, dependencies: {} } })).toThrow("complete dependency snapshot");
  expect(() => parseProjectArchive({ ...archive, project: { ...project, files: { "../escape.ts": "bad" } } })).toThrow("invalid project file");
  expect(() => parseProjectArchive({ ...archive, project: { ...project, lock: { "node_modules/../escape.js": "bad" } } })).toThrow("invalid dependency lock");
});

test("filesystem import/export keeps backend and exact dependencies through history, remix and restore", async () => {
  const directory = tempDir();
  const service = new ArtifactService({ artifactsDir: directory, cwd: directory, env: { ARTIFACTS_HISTORY_DB: join(directory, "history.sqlite") } });
  const source = 'import {value} from "./lib/value"; export default function App() { return <div>{value}</div>; }';
  const archive = projectArchive("artifact", { name: "portable", source, server_source: serverSource, project });
  const imported = service.importProject("fresh", archive);
  expect(imported.ok).toBe(true);
  expect(imported.runtime_notice).toContain("do not execute");
  const exported = service.exportProject({ name: "fresh" });
  expect(exported).toEqual({ ...archive, name: "fresh" });
  expect(existsSync(imported.path.replace(/\.tsx$/, ".data.json"))).toBe(false);
  expect((await service.compile("fresh")).ok).toBe(true);
  const original = service.history("fresh")[0]!;
  writeFileSync(localServerPath(imported.path), "changed backend");
  service.remix({ name: "fresh", new_name: "remixed" });
  expect(service.exportProject({ name: "remixed" }).server_source).toBe("changed backend");
  expect(service.exportProject({ version_id: original.version_id }).server_source).toBe(serverSource);
  service.restore(original.version_id);
  expect(service.exportProject({ name: "fresh" })).toEqual(exported);
  expect(() => service.importProject("fresh", archive)).toThrow("already exists");
  unlinkSync(imported.path);
  expect(() => service.importProject("fresh", archive)).toThrow("history");
  writeFileSync(join(directory, "orphan.artifact.data.json"), "{}");
  expect(() => service.importProject("orphan", archive)).toThrow("state already exists");
  symlinkSync(join(directory, "missing"), localProjectPath(join(directory, "symlink.artifact.tsx")));
  expect(() => service.importProject("symlink", archive)).toThrow("already exists");
  expect(service.exportProject({ version_id: original.version_id }).project.lock).toEqual(project.lock);
});

test("filesystem script archives round trip without executing or resolving dependencies", () => {
  const directory = tempDir();
  const service = new ArtifactService({ artifactsDir: directory, cwd: directory, env: { ARTIFACTS_HISTORY_DB: join(directory, "history.sqlite") } });
  const archive = projectArchive("script", { name: "handler", source: 'throw new Error("must not execute during filesystem import");', project });
  const imported = service.importProject("new-handler", archive);
  expect(imported).toMatchObject({ ok: true, imported: true, kind: "script" });
  expect(service.exportProject({ name: "new-handler", kind: "script" })).toEqual({ ...archive, name: "new-handler" });
  expect(() => service.importProject("new-handler", archive)).toThrow("already exists");
});
