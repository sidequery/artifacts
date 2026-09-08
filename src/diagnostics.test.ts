import { expect, test } from "bun:test";

import { formatArtifactCheck } from "./diagnostics";

test("formatArtifactCheck reports no errors", () => {
  expect(formatArtifactCheck([])).toBe("Artifact TypeScript check: no errors");
});

test("formatArtifactCheck counts errors", () => {
  expect(
    formatArtifactCheck([
      { severity: "error", message: "nope", file: "a.artifact.tsx", line: 3, column: 1 },
    ]),
  ).toContain("Artifact TypeScript check: 1 error");
});
