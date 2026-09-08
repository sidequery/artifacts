import { mkdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ArtifactHistory, historyPath } from "./history";
import { PLUGIN_ROOT } from "./paths";
import { tempDir } from "./test/fixtures";

test("history survives reconnect, scopes artifacts, and records distinct serves without duplicating unchanged source", () => {
  const dir = tempDir();
  const dbPath = join(dir, "history.sqlite");
  let history = new ArtifactHistory(dbPath);
  const input = { workspace: dir, name: "one", sourcePath: join(dir, "one.artifact.tsx"), source: "raw TSX", runtime: "runtime-a" };
  const version = history.capture(input);
  expect(history.capture({ ...input, runtime: "runtime-b" }).id).toBe(version.id);
  history.served(version.id, { count: 1 }, "live", { HERDR_PANE_ID: "w1:p2", HERDR_WORKSPACE_ID: "w1" }, "runtime-a");
  history.served(version.id, { count: 2 }, "live", {}, "runtime-b");
  history.close();
  history = new ArtifactHistory(dbPath);
  try {
    expect(history.version(version.id)?.source).toBe("raw TSX");
    expect(history.list(dir)).toHaveLength(1);
    expect(history.events(version.id).map(event => JSON.parse(event.initial_state).count)).toEqual([2, 1]);
    expect(history.events(version.id)[1]?.pane_id).toBe("w1:p2");
    const other = history.capture({ ...input, workspace: join(dir, "other") });
    expect(other.artifact_id).not.toBe(version.artifact_id);
    expect(history.version(other.id, dir)).toBeNull();
    expect(history.list(dir)).toHaveLength(1);
    expect(history.db.query("select name from sqlite_master where type = 'table' order by name").all()).toEqual([
      { name: "artifact_remixes" }, { name: "artifacts" }, { name: "serve_events" }, { name: "versions" },
    ]);
  } finally { history.close(); }
});

test("simultaneous processes share one revision for identical source", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "history.sqlite");
  const initial = new ArtifactHistory(dbPath);
  initial.close();
  const script = `import { ArtifactHistory } from ${JSON.stringify(join(PLUGIN_ROOT, "src/history.ts"))};
    const history = new ArtifactHistory(process.env.TEST_HISTORY_DB);
    for (let i = 0; i < 15; i++) history.capture({ workspace: process.env.TEST_WORKSPACE, name: 'shared', sourcePath: process.env.TEST_WORKSPACE + '/shared.artifact.tsx', source: 'same source', runtime: 'test' });
    history.close();`;
  const children = [0, 1, 2].map(() => Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, TEST_HISTORY_DB: dbPath, TEST_WORKSPACE: dir }, stdout: "pipe", stderr: "pipe",
  }));
  for (const child of children) {
    const stderr = await new Response(child.stderr).text();
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
  }
  const history = new ArtifactHistory(dbPath);
  try { expect(history.list(dir)).toHaveLength(1); }
  finally { history.close(); }
});

test("history path override does not depend on a pane's temporary plugin state directory", () => {
  const dir = tempDir();
  expect(historyPath({ ARTIFACTS_HISTORY_DB: join(dir, "archive.sqlite"), HERDR_PLUGIN_STATE_DIR: "/tmp/pane" })).toBe(join(dir, "archive.sqlite"));
  expect(historyPath({ HERDR_PLUGIN_STATE_DIR: "/tmp/pane" })).not.toContain("/tmp/pane");
});

test("legacy history file is reused without moving records or workspace keys", () => {
  const home = tempDir(), base = join(home, ".local", "share");
  const legacy = join(base, "herdr-canvas", "history.sqlite"), current = join(base, "artifacts", "history.sqlite");
  const workspace = join(home, "project", "canvases");
  const original = new ArtifactHistory(legacy);
  const version = original.capture({ workspace, name: "old", sourcePath: join(workspace, "old.canvas.tsx"), source: "original", runtime: "test" });
  original.close();
  mkdirSync(join(base, "artifacts"), { recursive: true });
  expect(historyPath({}, "linux", home)).toBe(legacy);
  const reopened = new ArtifactHistory(historyPath({}, "linux", home));
  expect(reopened.version(version.id, workspace)?.source_path).toBe(join(workspace, "old.canvas.tsx"));
  expect(reopened.list(workspace)[0]?.artifact_id).toBe(version.artifact_id);
  reopened.close();
  expect(historyPath({ HERDR_CANVAS_HISTORY_DB: legacy }, "linux", home)).toBe(legacy);
  expect(historyPath({ ARTIFACTS_HISTORY_DB: current, HERDR_CANVAS_HISTORY_DB: legacy }, "linux", home)).toBe(current);
  new ArtifactHistory(current).close();
  expect(historyPath({}, "linux", home)).toBe(current);
});
