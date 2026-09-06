import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { tempDir, VALID_CANVAS, writeCanvas } from "./test/fixtures";
import {
  canvasPaneConfig,
  paneInputCommand,
  runManagedCanvasPane,
  terminalBrowserCommand,
  type TerminalBrowserChild,
} from "./viewer";

test("canvasPaneConfig requires a canvas inside its managed directory", () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  expect(canvasPaneConfig({ HERDR_CANVAS_PATH: path, HERDR_CANVAS_DIR: dir })).toEqual({
    canvasPath: path,
    canvasesDir: dir,
    canvasId: "overview",
  });
  expect(() => canvasPaneConfig({ HERDR_CANVAS_PATH: path, HERDR_CANVAS_DIR: join(dir, "other") })).toThrow(
    "canvas path must be inside",
  );
});

test("terminalBrowserCommand opens the Canvas without browser chrome", () => {
  expect(terminalBrowserCommand("http://127.0.0.1:4567/c/overview", "/bin/terminal-browser")).toEqual([
    "/bin/terminal-browser",
    "open",
    "http://127.0.0.1:4567/c/overview",
    "--app-mode",
  ]);
});

test("paneInputCommand gives the Canvas pane application mouse routing", () => {
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

test("managed Canvas pane owns and stops its server around Terminal Browser", async () => {
  const dir = tempDir();
  const canvasPath = writeCanvas(dir, "overview", VALID_CANVAS);

  let stopped = false;
  let launched: string[] = [];
  let inputConfigured: string[] = [];
  const child = new EventEmitter() as EventEmitter & TerminalBrowserChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const running = runManagedCanvasPane({
    config: { canvasPath, canvasesDir: dir, canvasId: "overview" },
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
