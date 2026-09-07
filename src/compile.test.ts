import { expect, test } from "bun:test";

import { compileCanvas } from "./compile";
import { FETCH_CANVAS, FORBIDDEN_IMPORT_CANVAS, VALID_CANVAS, tempDir, writeCanvas } from "./test/fixtures";

test("compileCanvas bundles a valid canvas", async () => {
  const path = writeCanvas(tempDir(), "overview", VALID_CANVAS);
  const result = await compileCanvas(path);
  expect(result.ok).toBe(true);
  expect(result.js).toContain("Overview");
  expect(result.js).toContain("Open issues");
  expect(result.js).toContain("createRoot");
});

test("compileCanvas rejects forbidden imports before bundling", async () => {
  const path = writeCanvas(tempDir(), "bad", FORBIDDEN_IMPORT_CANVAS);
  const result = await compileCanvas(path);
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0]?.message).toContain("node:fs");
});

test("compileCanvas rejects fetch", async () => {
  const path = writeCanvas(tempDir(), "fetch", FETCH_CANVAS);
  const result = await compileCanvas(path);
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some((item) => item.message.includes("fetch()"))).toBe(true);
});

test("compileCanvas bundles a relative canvas path", async () => {
  const result = await compileCanvas("examples/overview.canvas.tsx");
  expect(result.ok).toBe(true);
  expect(result.js).toContain("herdr-canvas");
  expect(result.js).toContain("createRoot");
});

test("canonical and legacy SDK imports typecheck and compile ordinary React hooks", async () => {
  const { HOOKS_CANVAS } = await import("./test/fixtures");
  const { typecheckCanvas } = await import("./typecheck");
  for (const specifier of ["sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
    const path = writeCanvas(tempDir(), "hooks", HOOKS_CANVAS.replaceAll("sidequery/canvas", specifier));
    expect(typecheckCanvas(path)).toEqual([]);
    const result = await compileCanvas(path);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  }
}, 30000);
