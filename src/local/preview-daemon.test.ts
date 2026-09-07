import { expect, test } from "bun:test";
import { join } from "node:path";

import { daemonStatePath, ensureCanvasServer, writeDaemonState } from "./preview-daemon";
import { tempDir } from "../test/fixtures";
import { historyPath } from "../history";

test("ensureCanvasServer reuses a healthy daemon", async () => {
  const dir = tempDir();
  const statePath = daemonStatePath(dir, { HERDR_PLUGIN_STATE_DIR: dir });
  writeDaemonState(statePath, {
    pid: 1,
    port: 9,
    url: "http://127.0.0.1:9",
    canvasesDir: dir,
    historyDb: historyPath({}),
  });

  const result = await ensureCanvasServer({
    canvasesDir: dir,
    env: { HERDR_PLUGIN_STATE_DIR: dir },
    health: async (url) => url === "http://127.0.0.1:9",
    spawn: () => {
      throw new Error("should not spawn");
    },
  });
  expect(result).toEqual({ url: "http://127.0.0.1:9", reused: true });
});

test("ensureCanvasServer honors HERDR_CANVAS_SERVER_URL", async () => {
  const result = await ensureCanvasServer({
    canvasesDir: tempDir(),
    env: { HERDR_CANVAS_SERVER_URL: "http://127.0.0.1:5555" },
    spawn: () => {
      throw new Error("should not spawn");
    },
  });
  expect(result.url).toBe("http://127.0.0.1:5555");
  expect(result.reused).toBe(true);
});

test("ensureCanvasServer can start an in-process server", async () => {
  const dir = tempDir();
  const result = await ensureCanvasServer({
    canvasesDir: dir,
    env: { HERDR_PLUGIN_STATE_DIR: dir, HERDR_CANVAS_HISTORY_DB: join(dir, "history.sqlite") },
    inProcess: true,
    // Keep the test's database out of the user's durable archive.
  });
  expect(result.reused).toBe(false);
  expect(result.url).toContain("http://127.0.0.1:");
  const health = await fetch(`${result.url}/health`);
  expect(health.ok).toBe(true);
  result.server?.stop();
});

test("detached server identity separates history databases for the same canvases directory", async () => {
  const dir = tempDir();
  const envA = { HERDR_PLUGIN_STATE_DIR: dir, HERDR_CANVAS_HISTORY_DB: join(dir, "a.sqlite") };
  const envB = { HERDR_PLUGIN_STATE_DIR: dir, HERDR_CANVAS_HISTORY_DB: join(dir, "b.sqlite") };
  const a = await ensureCanvasServer({ canvasesDir: dir, env: envA, inProcess: true });
  const b = await ensureCanvasServer({ canvasesDir: dir, env: envB, inProcess: true });
  try {
    expect(a.url).not.toBe(b.url);
    expect(daemonStatePath(dir, envA)).not.toBe(daemonStatePath(dir, envB));
    expect((await ensureCanvasServer({ canvasesDir: dir, env: envA })).url).toBe(a.url);
    expect((await ensureCanvasServer({ canvasesDir: dir, env: envB })).url).toBe(b.url);
  } finally { a.server?.stop(); b.server?.stop(); }
});
