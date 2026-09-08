import { expect, test } from "bun:test";

import { scanArtifactSource } from "./sandbox";
import { BAD_TYPE_ARTIFACT, FETCH_ARTIFACT, FORBIDDEN_IMPORT_ARTIFACT, VALID_ARTIFACT } from "./test/fixtures";

test("scanArtifactSource accepts a valid artifact", () => {
  expect(scanArtifactSource(VALID_ARTIFACT)).toEqual([]);
});

test("scanArtifactSource rejects node imports", () => {
  const violations = scanArtifactSource(FORBIDDEN_IMPORT_ARTIFACT);
  expect(violations.some((item) => item.message.includes("node:fs"))).toBe(true);
});

test("scanArtifactSource rejects fetch", () => {
  const violations = scanArtifactSource(FETCH_ARTIFACT);
  expect(violations.some((item) => item.message.includes("fetch()"))).toBe(true);
});

test("scanArtifactSource requires a default export", () => {
  const violations = scanArtifactSource(`import { H1 } from "herdr/canvas";\nexport function App() { return <H1>Hi</H1>; }\n`);
  expect(violations.some((item) => item.kind === "export")).toBe(true);
});

test("scanArtifactSource allows type-only SDK imports", () => {
  const source = `import type { StatProps } from "herdr/canvas";
import { H1 } from "cursor/canvas";
export default function App(_props: StatProps) { return <H1>Hi</H1>; }
`;
  expect(scanArtifactSource(source)).toEqual([]);
});

test("comments do not trigger fetch detection", () => {
  const source = `import { H1 } from "herdr/canvas";
// fetch("nope")
export default function App() { return <H1>Hi</H1>; }
`;
  expect(scanArtifactSource(source)).toEqual([]);
});

test("bad types are not a sandbox violation", () => {
  expect(scanArtifactSource(BAD_TYPE_ARTIFACT)).toEqual([]);
});

test("repeated scans keep rejecting dynamic imports and require calls", () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(scanArtifactSource('export default function Artifact() { return import("herdr/canvas"); }').some(item => item.message.includes("dynamic import"))).toBe(true);
    expect(scanArtifactSource('export default function Artifact() { return require("herdr/canvas"); }').some(item => item.message.includes("require()"))).toBe(true);
  }
});

test("only documented Artifacts and historical Canvas SDK paths are allowed", () => {
  for (const specifier of ["sidequery/artifacts", "@sidequery/artifacts", "sidequery/canvas", "@sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
    expect(scanArtifactSource(`import { H1 } from "${specifier}"; export default function App() { return <H1>Hi</H1>; }`)).toEqual([]);
  }
  for (const specifier of ["herdr/artifact", "cursor/artifact"]) {
    expect(scanArtifactSource(`import { H1 } from "${specifier}"; export default function App() { return <H1>Hi</H1>; }`).some(item => item.kind === "import")).toBe(true);
  }
});
