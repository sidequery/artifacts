import { expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileArtifact } from "./compile";
import { ArtifactHistory } from "./history";
import { createArtifactServer } from "./serve";
import { ArtifactService } from "./service";
import { tempDir, VALID_ARTIFACT, writeArtifact } from "./test/fixtures";

function bridge(html: string) {
  return JSON.parse(html.match(/window\.__artifacts = (.*);<\/script>/)![1]);
}
function bundlePath(html: string) { return html.match(/src="([^\"]+bundle\.js[^\"]*)"/)![1]; }

test("direct edits create revisions; page bundles are pinned even if source changes before the JS request", async () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: dbPath });
  const history = new ArtifactHistory(dbPath);
  try {
    const first = await (await fetch(`${server.url}/c/overview`)).text();
    const firstVersion = bridge(first).versionId;
    writeFileSync(path, VALID_ARTIFACT.replaceAll("Overview", "EditedScene"));
    const oldJS = await (await fetch(server.url + bundlePath(first))).text();
    expect(oldJS).toContain("Overview");
    expect(oldJS).not.toContain("EditedScene");
    expect(history.version(firstVersion)?.source).toBe(VALID_ARTIFACT);
    const second = await (await fetch(`${server.url}/c/overview`)).text();
    expect(bridge(second).versionId).not.toBe(firstVersion);
    expect(await (await fetch(server.url + bundlePath(second))).text()).toContain("EditedScene");
    await fetch(`${server.url}/c/overview`);
    expect(history.list(dir)).toHaveLength(2);
    expect(history.events(bridge(second).versionId)).toHaveLength(2);
  } finally { server.stop(); history.close(); }
});

test("compile uses the exact captured source even when the file changes during compilation", async () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  const server = await createArtifactServer({
    artifactsDir: dir, historyPath: dbPath,
    compile: async (file, source) => {
      writeFileSync(path, VALID_ARTIFACT.replaceAll("Overview", "RacingEdit"));
      return compileArtifact(file, source);
    },
  });
  const history = new ArtifactHistory(dbPath);
  try {
    const html = await (await fetch(`${server.url}/c/overview`)).text();
    expect(history.version(bridge(html).versionId)?.source).toBe(VALID_ARTIFACT);
    const js = await (await fetch(server.url + bundlePath(html))).text();
    expect(js).toContain("Overview");
    expect(js).not.toContain("RacingEdit");
  } finally { server.stop(); history.close(); }
});

test("archived raw source reopens after deletion and server closure with the selected initial state", async () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  const opts = { artifactsDir: dir, historyPath: dbPath };
  let server = await createArtifactServer(opts);
  const history = new ArtifactHistory(dbPath);
  try {
    const statePath = path.replace(".tsx", ".data.json");
    writeFileSync(statePath, JSON.stringify({ label: "</script><script>unwanted()</script>", count: 1 }));
    const original = bridge(await (await fetch(`${server.url}/c/overview`)).text());
    await fetch(`${server.url}/c/overview/state`, { method: "PUT", body: JSON.stringify({ key: "count", value: 2 }) });
    await fetch(`${server.url}/c/overview`);
    server.stop();
    unlinkSync(path); // Disposable test fixture; history must outlive its source file.
    server = await createArtifactServer(opts);
    const response = await fetch(`${server.url}/v/${original.versionId}?event=${original.eventId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>unwanted()");
    const reopened = bridge(html);
    expect(reopened.state.count).toBe(1);
    expect(reopened.persistUrl).toBeUndefined();
    expect(reopened.actionUrl).toBeUndefined();
    expect(html).toContain("var last = null");
    expect(await (await fetch(server.url + bundlePath(html))).text()).toContain("Overview");
    expect(JSON.parse(readFileSync(statePath, "utf8")).count).toBe(2);
    expect(history.events(original.versionId)[0]?.mode).toBe("replay");
    expect((await fetch(`${server.url}/v/${original.versionId}?event=missing`)).status).toBe(404);
    expect((await fetch(`${server.url}/c/overview`)).status).toBe(404);
  } finally { server.stop(); history.close(); }
});

test("failed compilations are not recorded as served and versions cannot cross workspace boundaries", async () => {
  const dir = tempDir();
  writeArtifact(dir, "bad", "export default function ( broken");
  const dbPath = join(dir, "history.sqlite");
  const history = new ArtifactHistory(dbPath);
  const other = history.capture({ workspace: dir + "-other", name: "private", sourcePath: join(dir, "private.artifact.tsx"), source: VALID_ARTIFACT, runtime: "test" });
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: dbPath });
  try {
    expect((await fetch(`${server.url}/c/bad`)).status).toBe(400);
    expect(history.list(dir)).toHaveLength(0);
    expect((await fetch(`${server.url}/v/${other.id}`)).status).toBe(404);
    expect((await fetch(`${server.url}/c/..%2fprivate`)).status).toBe(400);
  } finally { server.stop(); history.close(); }
});

test("restore preserves unserved drafts, creates a new revision, retains UI state, and works after deletion", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  const history = new ArtifactHistory(dbPath);
  const original = history.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_ARTIFACT, runtime: "test" });
  const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: dbPath } });
  try {
    writeFileSync(path, "unfinished draft");
    const statePath = path.replace(".tsx", ".data.json");
    writeFileSync(statePath, '{"count":9}');
    const restored = service.restore(original.id);
    expect(restored.ok).toBe(true);
    expect(restored.revision).toBe(3);
    expect(readFileSync(path, "utf8")).toBe(VALID_ARTIFACT);
    expect(history.version(restored.versionId)?.restored_from).toBe(original.id);
    const draft = (history.list(dir) as Array<{ version_id: string; reason: string }>).find(row => row.reason === "before-restore")!;
    expect(history.version(draft.version_id)?.source).toBe("unfinished draft");
    expect(readFileSync(statePath, "utf8")).toBe('{"count":9}');
    unlinkSync(path);
    expect(service.restore(original.id).revision).toBe(4);
    expect(readFileSync(path, "utf8")).toBe(VALID_ARTIFACT);
    expect(history.list(dir)).toHaveLength(4);
  } finally { history.close(); }
}, { timeout: 30_000 });

test("restore detects an edit made after its preservation snapshot and leaves that edit untouched", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  const archive = new ArtifactHistory(dbPath);
  const version = archive.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_ARTIFACT, runtime: "test" });
  writeFileSync(path, "first unserved draft");
  const capture = ArtifactHistory.prototype.capture;
  const spy = spyOn(ArtifactHistory.prototype, "capture").mockImplementation(function (this: ArtifactHistory, input) {
    const result = capture.call(this, input);
    if (input.reason === "before-restore") writeFileSync(path, "concurrent editor change");
    return result;
  });
  try {
    const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: dbPath } });
    expect(() => service.restore(version.id)).toThrow("artifact changed during restore");
    expect(readFileSync(path, "utf8")).toBe("concurrent editor change");
    expect(archive.list(dir)).toHaveLength(2);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { spy.mockRestore(); archive.close(); }
});

test("live serving and restore reject symlinked sources without modifying the external target", async () => {
  const dir = tempDir();
  const outside = writeArtifact(tempDir(), "outside", VALID_ARTIFACT);
  const path = join(dir, "overview.artifact.tsx");
  symlinkSync(outside, path);
  const dbPath = join(dir, "history.sqlite");
  const archive = new ArtifactHistory(dbPath);
  const target = archive.capture({ workspace: dir, name: "overview", sourcePath: path, source: "different source", runtime: "test" });
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: dbPath });
  try {
    expect((await fetch(`${server.url}/c/overview`)).status).toBe(400);
    expect(archive.events(target.id)).toHaveLength(0);
    const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: dbPath } });
    expect(() => service.restore(target.id)).toThrow("not a symlink");
    expect(readFileSync(outside, "utf8")).toBe(VALID_ARTIFACT);
  } finally { server.stop(); archive.close(); }
});

test("SDK changes invalidate memory bundles and each serve records the actual runtime", async () => {
  const dir = tempDir();
  writeArtifact(dir, "overview", VALID_ARTIFACT);
  const dbPath = join(dir, "history.sqlite");
  let runtime = "sdk-a";
  let builds = 0;
  const server = await createArtifactServer({
    artifactsDir: dir, historyPath: dbPath, runtimeIdentity: () => runtime,
    compile: async () => { builds++; return { ok: true, js: `export default '${runtime}';`, diagnostics: [] }; },
  });
  const archive = new ArtifactHistory(dbPath);
  try {
    const first = await (await fetch(`${server.url}/c/overview`)).text();
    runtime = "sdk-b";
    // Updating the SDK between HTML and JS must not change the page's compiled generation.
    expect(await (await fetch(server.url + bundlePath(first))).text()).toContain("sdk-a");
    expect(builds).toBe(1);
    const second = await (await fetch(`${server.url}/c/overview`)).text();
    expect(bridge(second).versionId).toBe(bridge(first).versionId);
    expect(await (await fetch(server.url + bundlePath(second))).text()).toContain("sdk-b");
    expect(builds).toBe(2);
    expect(archive.events(bridge(first).versionId).map(event => event.runtime)).toEqual(["sdk-b", "sdk-a"]);
    expect((await fetch(`${server.url}/v/${bridge(first).versionId}/bundle.js?runtime=expired`)).status).toBe(409);
  } finally { server.stop(); archive.close(); }
});

test("legacy source, project, state and history stay paired through serving and edits", async () => {
  const dir = tempDir(), path = join(dir, "legacy.canvas.tsx"), dbPath = join(dir, "history.sqlite");
  writeFileSync(path, VALID_ARTIFACT);
  writeFileSync(`${path}.project.json`, JSON.stringify({ files: { "note.json": "{}" }, dependencies: {}, lock: {} }));
  writeFileSync(join(dir, "legacy.canvas.data.json"), JSON.stringify({ count: 7 }));
  const service = new ArtifactService({ artifactsDir: dir, env: { HERDR_CANVAS_HISTORY_DB: dbPath } });
  expect(service.list()[0]?.path).toBe(path);
  expect(service.readRange("legacy").project.files["note.json"]).toBe("{}");
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: dbPath });
  const history = new ArtifactHistory(dbPath);
  try {
    const response = await fetch(`${server.url}/c/legacy`);
    expect(response.status).toBe(200);
    const first = bridge(await response.text());
    expect(first.state.count).toBe(7);
    expect(history.version(first.versionId)?.source_path).toBe(path);
    await fetch(`${server.url}/c/legacy/state`, { method: "PUT", body: JSON.stringify({ key: "count", value: 8 }) });
    expect(JSON.parse(readFileSync(join(dir, "legacy.canvas.data.json"), "utf8")).count).toBe(8);
    service.edit("legacy", [{ old_text: "<H1>Overview</H1>", new_text: "<H1>Legacy Edit</H1>" }]);
    expect(readFileSync(path, "utf8")).toContain("Legacy Edit");
    expect(service.restore(first.versionId).path).toBe(path);
    unlinkSync(path);
    expect(service.restore(first.versionId).path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(VALID_ARTIFACT);
    expect(readdirSync(dir)).not.toContain("legacy.artifact.tsx");
    expect(readdirSync(dir)).not.toContain("legacy.artifact.data.json");
    expect(service.readRange("legacy").project.files["note.json"]).toBe("{}");
  } finally { server.stop(); history.close(); }
}, 30_000);
