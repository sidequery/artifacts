import { expect, test } from "bun:test";

import { formatCanvasCheck } from "./diagnostics";
import { BAD_TYPE_CANVAS, FORBIDDEN_IMPORT_CANVAS, VALID_CANVAS, tempDir, writeCanvas } from "./test/fixtures";
import { typecheckCanvas } from "./typecheck";

test(
  "typecheckCanvas accepts a valid canvas",
  () => {
    const path = writeCanvas(tempDir(), "overview", VALID_CANVAS);
    expect(typecheckCanvas(path)).toEqual([]);
  },
  { timeout: 30_000 },
);

test("typecheckCanvas reports sandbox violations first", () => {
  const path = writeCanvas(tempDir(), "bad", FORBIDDEN_IMPORT_CANVAS);
  const diagnostics = typecheckCanvas(path);
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(formatCanvasCheck(diagnostics)).toContain("Canvas TypeScript check:");
  expect(diagnostics.some((item) => item.message.includes("node:fs"))).toBe(true);
});

test(
  "typecheckCanvas flags incorrect SDK prop types",
  () => {
    const path = writeCanvas(tempDir(), "types", BAD_TYPE_CANVAS);
    const diagnostics = typecheckCanvas(path);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((item) => /string/i.test(item.message) || /gap/i.test(item.message))).toBe(true);
  },
  { timeout: 30_000 },
);
