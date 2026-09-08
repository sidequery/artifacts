import { expect, test } from "bun:test";

import { formatArtifactCheck } from "./diagnostics";
import { BAD_TYPE_ARTIFACT, FORBIDDEN_IMPORT_ARTIFACT, VALID_ARTIFACT, tempDir, writeArtifact } from "./test/fixtures";
import { typecheckArtifact } from "./typecheck";

test(
  "typecheckArtifact accepts a valid artifact",
  () => {
    const path = writeArtifact(tempDir(), "overview", VALID_ARTIFACT);
    expect(typecheckArtifact(path)).toEqual([]);
  },
  { timeout: 30_000 },
);

test("typecheckArtifact reports sandbox violations first", () => {
  const path = writeArtifact(tempDir(), "bad", FORBIDDEN_IMPORT_ARTIFACT);
  const diagnostics = typecheckArtifact(path);
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(formatArtifactCheck(diagnostics)).toContain("Artifact TypeScript check:");
  expect(diagnostics.some((item) => item.message.includes("node:fs"))).toBe(true);
});

test(
  "typecheckArtifact flags incorrect SDK prop types",
  () => {
    const path = writeArtifact(tempDir(), "types", BAD_TYPE_ARTIFACT);
    const diagnostics = typecheckArtifact(path);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((item) => /string/i.test(item.message) || /gap/i.test(item.message))).toBe(true);
  },
  { timeout: 30_000 },
);
