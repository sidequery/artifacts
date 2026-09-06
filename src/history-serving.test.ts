import { expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileCanvas } from "./compile";
import { CanvasHistory } from "./history";
import { createCanvasServer } from "./serve";
import { CanvasService } from "./service";
import { tempDir, VALID_CANVAS, writeCanvas } from "./test/fixtures";

function bridge(html: string) {
  return JSON.parse(html.match(/window\.__herdrCanvas = (.*);<\/script>/)![1]);
}
function bundlePath(html: string) { return html.match(/src="([^\"]+bundle\.js[^\"]*)"/)![1]; }

test("direct edits create revisions; page bundles are pinned even if source changes before the JS request", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath });
  const history = new CanvasHistory(dbPath);
  try {
    const first = await (await fetch(`${server.url}/c/overview`)).text();
    const firstVersion = bridge(first).versionId;
    writeFileSync(path, VALID_CANVAS.replaceAll("Overview", "EditedScene"));
    const oldJS = await (await fetch(server.url + bundlePath(first))).text();
    expect(oldJS).toContain("Overview");
    expect(oldJS).not.toContain("EditedScene");
    expect(history.version(firstVersion)?.source).toBe(VALID_CANVAS);
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
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const server = await createCanvasServer({
    canvasesDir: dir, historyPath: dbPath,
    compile: async (file, source) => {
      writeFileSync(path, VALID_CANVAS.replaceAll("Overview", "RacingEdit"));
      return compileCanvas(file, source);
    },
  });
  const history = new CanvasHistory(dbPath);
  try {
    const html = await (await fetch(`${server.url}/c/overview`)).text();
    expect(history.version(bridge(html).versionId)?.source).toBe(VALID_CANVAS);
    const js = await (await fetch(server.url + bundlePath(html))).text();
    expect(js).toContain("Overview");
    expect(js).not.toContain("RacingEdit");
  } finally { server.stop(); history.close(); }
});

test("archived raw source reopens after deletion and server closure with the selected initial state", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const opts = { canvasesDir: dir, historyPath: dbPath };
  let server = await createCanvasServer(opts);
  const history = new CanvasHistory(dbPath);
  try {
    const statePath = path.replace(".tsx", ".data.json");
    writeFileSync(statePath, JSON.stringify({ label: "</script><script>unwanted()</script>", count: 1 }));
    const original = bridge(await (await fetch(`${server.url}/c/overview`)).text());
    await fetch(`${server.url}/c/overview/state`, { method: "PUT", body: JSON.stringify({ key: "count", value: 2 }) });
    await fetch(`${server.url}/c/overview`);
    server.stop();
    unlinkSync(path); // Disposable test fixture; history must outlive its source file.
    server = await createCanvasServer(opts);
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
  writeCanvas(dir, "bad", "export default function ( broken");
  const dbPath = join(dir, "history.sqlite");
  const history = new CanvasHistory(dbPath);
  const other = history.capture({ workspace: dir + "-other", name: "private", sourcePath: join(dir, "private.canvas.tsx"), source: VALID_CANVAS, runtime: "test" });
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath });
  try {
    expect((await fetch(`${server.url}/c/bad`)).status).toBe(400);
    expect(history.list(dir)).toHaveLength(0);
    expect((await fetch(`${server.url}/v/${other.id}`)).status).toBe(404);
    expect((await fetch(`${server.url}/c/..%2fprivate`)).status).toBe(400);
  } finally { server.stop(); history.close(); }
});

test("restore preserves unserved drafts, creates a new revision, retains UI state, and works after deletion", () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const history = new CanvasHistory(dbPath);
  const original = history.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_CANVAS, runtime: "test" });
  const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: dbPath } });
  try {
    writeFileSync(path, "unfinished draft");
    const statePath = path.replace(".tsx", ".data.json");
    writeFileSync(statePath, '{"count":9}');
    const restored = service.restore(original.id);
    expect(restored.ok).toBe(true);
    expect(restored.revision).toBe(3);
    expect(readFileSync(path, "utf8")).toBe(VALID_CANVAS);
    expect(history.version(restored.versionId)?.restored_from).toBe(original.id);
    const draft = (history.list(dir) as Array<{ version_id: string; reason: string }>).find(row => row.reason === "before-restore")!;
    expect(history.version(draft.version_id)?.source).toBe("unfinished draft");
    expect(readFileSync(statePath, "utf8")).toBe('{"count":9}');
    unlinkSync(path);
    expect(service.restore(original.id).revision).toBe(4);
    expect(readFileSync(path, "utf8")).toBe(VALID_CANVAS);
    expect(history.list(dir)).toHaveLength(4);
  } finally { history.close(); }
}, { timeout: 30_000 });

test("restore detects an edit made after its preservation snapshot and leaves that edit untouched", () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const archive = new CanvasHistory(dbPath);
  const version = archive.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_CANVAS, runtime: "test" });
  writeFileSync(path, "first unserved draft");
  const capture = CanvasHistory.prototype.capture;
  const spy = spyOn(CanvasHistory.prototype, "capture").mockImplementation(function (this: CanvasHistory, input) {
    const result = capture.call(this, input);
    if (input.reason === "before-restore") writeFileSync(path, "concurrent editor change");
    return result;
  });
  try {
    const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: dbPath } });
    expect(() => service.restore(version.id)).toThrow("canvas changed during restore");
    expect(readFileSync(path, "utf8")).toBe("concurrent editor change");
    expect(archive.list(dir)).toHaveLength(2);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { spy.mockRestore(); archive.close(); }
});

test("live serving and restore reject symlinked sources without modifying the external target", async () => {
  const dir = tempDir();
  const outside = writeCanvas(tempDir(), "outside", VALID_CANVAS);
  const path = join(dir, "overview.canvas.tsx");
  symlinkSync(outside, path);
  const dbPath = join(dir, "history.sqlite");
  const archive = new CanvasHistory(dbPath);
  const target = archive.capture({ workspace: dir, name: "overview", sourcePath: path, source: "different source", runtime: "test" });
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath });
  try {
    expect((await fetch(`${server.url}/c/overview`)).status).toBe(400);
    expect(archive.events(target.id)).toHaveLength(0);
    const service = new CanvasService({ canvasesDir: dir, env: { HERDR_CANVAS_HISTORY_DB: dbPath } });
    expect(() => service.restore(target.id)).toThrow("not a symlink");
    expect(readFileSync(outside, "utf8")).toBe(VALID_CANVAS);
  } finally { server.stop(); archive.close(); }
});

test("SDK changes invalidate memory bundles and each serve records the actual runtime", async () => {
  const dir = tempDir();
  writeCanvas(dir, "overview", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  let runtime = "sdk-a";
  let builds = 0;
  const server = await createCanvasServer({
    canvasesDir: dir, historyPath: dbPath, runtimeIdentity: () => runtime,
    compile: async () => { builds++; return { ok: true, js: `export default '${runtime}';`, diagnostics: [] }; },
  });
  const archive = new CanvasHistory(dbPath);
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
