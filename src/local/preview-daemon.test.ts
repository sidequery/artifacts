import { expect, test } from "bun:test";
import { join } from "node:path";

import { daemonStatePath, ensureArtifactServer, writeDaemonState } from "./preview-daemon";
import { tempDir } from "../test/fixtures";
import { historyPath } from "../history";

test("ensureArtifactServer reuses a healthy daemon", async () => {
  const dir = tempDir();
  const statePath = daemonStatePath(dir, { HERDR_PLUGIN_STATE_DIR: dir });
  writeDaemonState(statePath, {
    pid: 1,
    port: 9,
    url: "http://127.0.0.1:9",
    artifactsDir: dir,
    historyDb: historyPath({}),
  });

  const result = await ensureArtifactServer({
    artifactsDir: dir,
    env: { HERDR_PLUGIN_STATE_DIR: dir },
    health: async (url) => url === "http://127.0.0.1:9",
    spawn: () => {
      throw new Error("should not spawn");
    },
  });
  expect(result).toEqual({ url: "http://127.0.0.1:9", reused: true });
});

test("ensureArtifactServer honors ARTIFACTS_SERVER_URL", async () => {
  const result = await ensureArtifactServer({
    artifactsDir: tempDir(),
    env: { ARTIFACTS_SERVER_URL: "http://127.0.0.1:5555" },
    spawn: () => {
      throw new Error("should not spawn");
    },
  });
  expect(result.url).toBe("http://127.0.0.1:5555");
  expect(result.reused).toBe(true);
});

test("ensureArtifactServer can start an in-process server", async () => {
  const dir = tempDir();
  const result = await ensureArtifactServer({
    artifactsDir: dir,
    env: { HERDR_PLUGIN_STATE_DIR: dir, ARTIFACTS_HISTORY_DB: join(dir, "history.sqlite") },
    inProcess: true,
    // Keep the test's database out of the user's durable archive.
  });
  expect(result.reused).toBe(false);
  expect(result.url).toContain("http://127.0.0.1:");
  const health = await fetch(`${result.url}/health`);
  expect(health.ok).toBe(true);
  result.server?.stop();
});

test("detached server identity separates history databases for the same artifacts directory", async () => {
  const dir = tempDir();
  const envA = { HERDR_PLUGIN_STATE_DIR: dir, ARTIFACTS_HISTORY_DB: join(dir, "a.sqlite") };
  const envB = { HERDR_PLUGIN_STATE_DIR: dir, ARTIFACTS_HISTORY_DB: join(dir, "b.sqlite") };
  const a = await ensureArtifactServer({ artifactsDir: dir, env: envA, inProcess: true });
  const b = await ensureArtifactServer({ artifactsDir: dir, env: envB, inProcess: true });
  try {
    expect(a.url).not.toBe(b.url);
    expect(daemonStatePath(dir, envA)).not.toBe(daemonStatePath(dir, envB));
    expect((await ensureArtifactServer({ artifactsDir: dir, env: envA })).url).toBe(a.url);
    expect((await ensureArtifactServer({ artifactsDir: dir, env: envB })).url).toBe(b.url);
  } finally { a.server?.stop(); b.server?.stop(); }
});
