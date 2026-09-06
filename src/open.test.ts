import { expect, test } from "bun:test";

import { openCanvas } from "./open";
import { FORBIDDEN_IMPORT_CANVAS, VALID_CANVAS, tempDir, writeCanvas } from "./test/fixtures";

test("openCanvas refuses a sandboxed-invalid canvas without contacting Herdr", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "bad", FORBIDDEN_IMPORT_CANVAS);
  const result = await openCanvas(path, { canvasesDir: dir });
  expect(result.ok).toBe(false);
  expect(result.opened).toBe("none");
  expect(result.check).toContain("Canvas TypeScript check:");
});

test("openCanvas opens herdr.canvas without starting a detached server", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "overview", VALID_CANVAS);
  const calls: string[][] = [];
  const result = await openCanvas(path, {
    canvasesDir: dir,
    ensureServer: async () => {
      throw new Error("normal Canvas opens must not start the detached server");
    },
    herdr: {
      bin: "herdr",
      run(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify({ result: { plugin_pane: { plugin_id: "herdr.canvas" } } }),
          stderr: "",
        };
      },
    },
    env: {
      HERDR_WORKSPACE_ID: "w15",
      HERDR_PANE_ID: "w15:p1",
    },
  });
  expect(result.ok).toBe(true);
  expect(result.opened).toBe("canvas-pane");
  expect(result.url).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("herdr.canvas");
  expect(calls[0]).toContain("HERDR_CANVAS_PATH=" + path);
  expect(calls[0]).toContain("HERDR_CANVAS_DIR=" + dir);
  expect(calls[0]).toContain("--target-pane");
  expect(calls[0]).toContain("w15:p1");
  expect(calls[0]).not.toContain("--workspace");
});
