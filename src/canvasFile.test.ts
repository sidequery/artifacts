import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canvasIdFromFile,
  canvasesDirFrom,
  ensureCanvasFileName,
  listCanvasFiles,
  resolveCanvasFile,
} from "./canvasFile";
import { tempDir, VALID_CANVAS, writeCanvas } from "./test/fixtures";

test("canvasesDirFrom uses env override", () => {
  expect(canvasesDirFrom("/tmp/proj", { HERDR_CANVAS_DIR: "/var/canvases" })).toBe("/var/canvases");
});

test("canvasesDirFrom reads worktree context", () => {
  expect(
    canvasesDirFrom("/tmp/proj", {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { path: "/repo" } }),
    }),
  ).toBe("/repo/canvases");
});

test("ensureCanvasFileName rejects slashes", () => {
  expect(() => ensureCanvasFileName("../etc/passwd")).toThrow("slashes");
});

test("resolveCanvasFile maps a bare name into the canvases dir", () => {
  expect(resolveCanvasFile("billing-review", "/tmp/canvases")).toBe(
    join("/tmp/canvases", "billing-review.canvas.tsx"),
  );
});

test("listCanvasFiles returns only canvas sources", () => {
  const dir = tempDir();
  writeCanvas(dir, "one", VALID_CANVAS);
  writeFileSync(join(dir, "notes.md"), "hi");
  expect(listCanvasFiles(dir).map((path) => canvasIdFromFile(path))).toEqual(["one"]);
});
