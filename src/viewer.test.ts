import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { tempDir, VALID_ARTIFACT, writeArtifact } from "./test/fixtures";
import {
  artifactPaneConfig,
  paneInputCommand,
  runManagedArtifactPane,
  terminalBrowserCommand,
  type TerminalBrowserChild,
} from "./viewer";

test("artifactPaneConfig requires an artifact inside its managed directory", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  expect(artifactPaneConfig({ ARTIFACTS_PATH: path, ARTIFACTS_DIR: dir })).toEqual({
    artifactPath: path,
    artifactsDir: dir,
    artifactId: "overview",
  });
  expect(() => artifactPaneConfig({ ARTIFACTS_PATH: path, ARTIFACTS_DIR: join(dir, "other") })).toThrow(
    "artifact path must be inside",
  );
});

test("terminalBrowserCommand opens the Artifact without browser chrome", () => {
  expect(terminalBrowserCommand("http://127.0.0.1:4567/c/overview", "/bin/terminal-browser")).toEqual([
    "/bin/terminal-browser",
    "open",
    "http://127.0.0.1:4567/c/overview",
    "--app-mode",
  ]);
});

test("existing pane environment remains readable and Artifacts values take priority", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  expect(artifactPaneConfig({ HERDR_CANVAS_PATH: path, HERDR_CANVAS_DIR: dir })).toEqual({
    artifactPath: path, artifactsDir: dir, artifactId: "overview",
  });
  expect(artifactPaneConfig({ ARTIFACTS_PATH: path, ARTIFACTS_DIR: dir, HERDR_CANVAS_PATH: "/missing", HERDR_CANVAS_DIR: "/missing" }).artifactPath).toBe(path);
});

test("paneInputCommand gives the Artifact pane application mouse routing", () => {
  expect(paneInputCommand({ HERDR_BIN_PATH: "/bin/herdr", HERDR_PANE_ID: "w1:p2" })).toEqual([
    "/bin/herdr",
    "pane",
    "input",
    "--pane",
    "w1:p2",
    "--right-click",
    "pane",
  ]);
  expect(() => paneInputCommand({})).toThrow("HERDR_PANE_ID is required");
});

test("managed Artifact pane owns and stops its server around Terminal Browser", async () => {
  const dir = tempDir();
  const artifactPath = writeArtifact(dir, "overview", VALID_ARTIFACT);

  let stopped = false;
  let launched: string[] = [];
  let inputConfigured: string[] = [];
  const child = new EventEmitter() as EventEmitter & TerminalBrowserChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const running = runManagedArtifactPane({
    config: { artifactPath, artifactsDir: dir, artifactId: "overview" },
    env: { HERDR_PANE_ID: "w1:p2" },
    terminalBrowserBin: "/bin/terminal-browser",
    createServer: async () => ({
      url: "http://127.0.0.1:4567",
      port: 4567,
      stop() {
        stopped = true;
      },
    }),
    configurePaneInput(command) {
      inputConfigured = command;
    },
    spawnBrowser(command, env) {
      launched = command;
      expect(env.HERDR_PANE_ID).toBe("w1:p2");
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  expect(await running).toBe(0);
  expect(launched).toEqual([
    "/bin/terminal-browser",
    "open",
    "http://127.0.0.1:4567/c/overview",
    "--app-mode",
  ]);
  expect(inputConfigured).toEqual([
    "herdr",
    "pane",
    "input",
    "--pane",
    "w1:p2",
    "--right-click",
    "pane",
  ]);
  expect(stopped).toBe(true);
});
