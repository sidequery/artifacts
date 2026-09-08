import { expect, test } from "bun:test";

import { artifactPaneOpenArgs } from "./herdr";

test("artifactPaneOpenArgs opens an Artifact-owned pane beside its caller", () => {
  const args = artifactPaneOpenArgs("/repo/artifacts/overview.artifact.tsx", "/repo/artifacts", {
    placement: "split",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).toContain("herdr.artifacts");
  expect(args).toContain("ARTIFACTS_PATH=/repo/artifacts/overview.artifact.tsx");
  expect(args).toContain("ARTIFACTS_DIR=/repo/artifacts");
  expect(args).toContain("--target-pane");
  expect(args).toContain("w15:p1");
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--direction");
  expect(args).toContain("right");
  expect(args).toContain("--focus");
});

test("artifactPaneOpenArgs omits targets and split direction for overlays", () => {
  const args = artifactPaneOpenArgs("/repo/artifacts/overview.artifact.tsx", "/repo/artifacts", { placement: "overlay", focus: false });
  expect(args).not.toContain("--direction");
  expect(args).not.toContain("--target-pane");
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--no-focus");
});

test("artifactPaneOpenArgs targets tab placement by workspace only", () => {
  const args = artifactPaneOpenArgs("/repo/artifacts/overview.artifact.tsx", "/repo/artifacts", {
    placement: "tab",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).toContain("--workspace");
  expect(args).toContain("w15");
  expect(args).not.toContain("--target-pane");
  expect(args).not.toContain("--direction");
});

test("artifactPaneOpenArgs targets zoomed placement by pane without split direction", () => {
  const args = artifactPaneOpenArgs("/repo/artifacts/overview.artifact.tsx", "/repo/artifacts", {
    placement: "zoomed",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--target-pane");
  expect(args).toContain("w15:p1");
  expect(args).not.toContain("--direction");
});
