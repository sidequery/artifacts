import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  artifactIdFromFile,
  artifactsDirFrom,
  ensureArtifactFileName,
  listArtifactFiles,
  resolveArtifactFile,
} from "./artifactFile";
import { tempDir, VALID_ARTIFACT, writeArtifact } from "./test/fixtures";

test("artifactsDirFrom uses env override", () => {
  expect(artifactsDirFrom("/tmp/proj", { ARTIFACTS_DIR: "/var/artifacts" })).toBe("/var/artifacts");
});

test("artifactsDirFrom reads worktree context", () => {
  expect(
    artifactsDirFrom("/tmp/proj", {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { path: "/repo" } }),
    }),
  ).toBe("/repo/artifacts");
});

test("ensureArtifactFileName rejects slashes", () => {
  expect(() => ensureArtifactFileName("../etc/passwd")).toThrow("slashes");
});

test("resolveArtifactFile maps a bare name into the artifacts dir", () => {
  expect(resolveArtifactFile("billing-review", "/tmp/artifacts")).toBe(
    join("/tmp/artifacts", "billing-review.artifact.tsx"),
  );
});

test("listArtifactFiles returns only artifact sources", () => {
  const dir = tempDir();
  writeArtifact(dir, "one", VALID_ARTIFACT);
  writeFileSync(join(dir, "notes.md"), "hi");
  expect(listArtifactFiles(dir).map((path) => artifactIdFromFile(path))).toEqual(["one"]);
});

test("existing Canvas workspace and filenames remain in place with explicit override precedence", () => {
  const root = tempDir(), legacy = join(root, "canvases"), current = join(root, "artifacts");
  mkdirSync(legacy);
  expect(artifactsDirFrom(root, {})).toBe(legacy);
  expect(artifactsDirFrom(root, { HERDR_CANVAS_DIR: legacy })).toBe(legacy);
  expect(artifactsDirFrom(root, { HERDR_CANVAS_DIR: legacy, ARTIFACTS_DIR: current })).toBe(current);
  const file = join(legacy, "old.canvas.tsx");
  writeFileSync(file, VALID_ARTIFACT);
  expect(resolveArtifactFile("old", legacy)).toBe(file);
  expect(resolveArtifactFile("old.canvas.tsx", legacy)).toBe(file);
  expect(listArtifactFiles(legacy).map(artifactIdFromFile)).toEqual(["old"]);
  expect(resolveArtifactFile("fresh", legacy)).toBe(join(legacy, "fresh.artifact.tsx"));
  writeArtifact(legacy, "old", VALID_ARTIFACT);
  expect(() => resolveArtifactFile("old", legacy)).toThrow("ambiguous");
  expect(resolveArtifactFile("old.artifact.tsx", legacy)).toBe(join(legacy, "old.artifact.tsx"));
  mkdirSync(current);
  expect(artifactsDirFrom(root, {})).toBe(current);
});
