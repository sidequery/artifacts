import { expect, test } from "bun:test";

import { scanCanvasSource } from "./sandbox";
import { BAD_TYPE_CANVAS, FETCH_CANVAS, FORBIDDEN_IMPORT_CANVAS, VALID_CANVAS } from "./test/fixtures";

test("scanCanvasSource accepts a valid canvas", () => {
  expect(scanCanvasSource(VALID_CANVAS)).toEqual([]);
});

test("scanCanvasSource rejects node imports", () => {
  const violations = scanCanvasSource(FORBIDDEN_IMPORT_CANVAS);
  expect(violations.some((item) => item.message.includes("node:fs"))).toBe(true);
});

test("scanCanvasSource rejects fetch", () => {
  const violations = scanCanvasSource(FETCH_CANVAS);
  expect(violations.some((item) => item.message.includes("fetch()"))).toBe(true);
});

test("scanCanvasSource requires a default export", () => {
  const violations = scanCanvasSource(`import { H1 } from "herdr/canvas";\nexport function App() { return <H1>Hi</H1>; }\n`);
  expect(violations.some((item) => item.kind === "export")).toBe(true);
});

test("scanCanvasSource allows type-only SDK imports", () => {
  const source = `import type { StatProps } from "herdr/canvas";
import { H1 } from "cursor/canvas";
export default function App(_props: StatProps) { return <H1>Hi</H1>; }
`;
  expect(scanCanvasSource(source)).toEqual([]);
});

test("comments do not trigger fetch detection", () => {
  const source = `import { H1 } from "herdr/canvas";
// fetch("nope")
export default function App() { return <H1>Hi</H1>; }
`;
  expect(scanCanvasSource(source)).toEqual([]);
});

test("bad types are not a sandbox violation", () => {
  expect(scanCanvasSource(BAD_TYPE_CANVAS)).toEqual([]);
});

test("repeated scans keep rejecting dynamic imports and require calls", () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(scanCanvasSource('export default function Canvas() { return import("herdr/canvas"); }').some(item => item.message.includes("dynamic import"))).toBe(true);
    expect(scanCanvasSource('export default function Canvas() { return require("herdr/canvas"); }').some(item => item.message.includes("require()"))).toBe(true);
  }
});
