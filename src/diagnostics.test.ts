import { expect, test } from "bun:test";

import { formatCanvasCheck } from "./diagnostics";

test("formatCanvasCheck reports no errors", () => {
  expect(formatCanvasCheck([])).toBe("Canvas TypeScript check: no errors");
});

test("formatCanvasCheck counts errors", () => {
  expect(
    formatCanvasCheck([
      { severity: "error", message: "nope", file: "a.canvas.tsx", line: 3, column: 1 },
    ]),
  ).toContain("Canvas TypeScript check: 1 error");
});
