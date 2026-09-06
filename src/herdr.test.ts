import { expect, test } from "bun:test";

import { canvasPaneOpenArgs } from "./herdr";

test("canvasPaneOpenArgs opens a Canvas-owned pane beside its caller", () => {
  const args = canvasPaneOpenArgs("/repo/canvases/overview.canvas.tsx", "/repo/canvases", {
    placement: "split",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).toContain("herdr.canvas");
  expect(args).toContain("HERDR_CANVAS_PATH=/repo/canvases/overview.canvas.tsx");
  expect(args).toContain("HERDR_CANVAS_DIR=/repo/canvases");
  expect(args).toContain("--target-pane");
  expect(args).toContain("w15:p1");
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--direction");
  expect(args).toContain("right");
  expect(args).toContain("--focus");
});

test("canvasPaneOpenArgs omits targets and split direction for overlays", () => {
  const args = canvasPaneOpenArgs("/repo/canvases/overview.canvas.tsx", "/repo/canvases", { placement: "overlay", focus: false });
  expect(args).not.toContain("--direction");
  expect(args).not.toContain("--target-pane");
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--no-focus");
});

test("canvasPaneOpenArgs targets tab placement by workspace only", () => {
  const args = canvasPaneOpenArgs("/repo/canvases/overview.canvas.tsx", "/repo/canvases", {
    placement: "tab",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).toContain("--workspace");
  expect(args).toContain("w15");
  expect(args).not.toContain("--target-pane");
  expect(args).not.toContain("--direction");
});

test("canvasPaneOpenArgs targets zoomed placement by pane without split direction", () => {
  const args = canvasPaneOpenArgs("/repo/canvases/overview.canvas.tsx", "/repo/canvases", {
    placement: "zoomed",
    workspaceId: "w15",
    targetPaneId: "w15:p1",
  });
  expect(args).not.toContain("--workspace");
  expect(args).toContain("--target-pane");
  expect(args).toContain("w15:p1");
  expect(args).not.toContain("--direction");
});
