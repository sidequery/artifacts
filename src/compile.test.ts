import { expect, test } from "bun:test";

import { compileArtifact } from "./compile";
import { FETCH_ARTIFACT, FORBIDDEN_IMPORT_ARTIFACT, VALID_ARTIFACT, tempDir, writeArtifact } from "./test/fixtures";

test("compileArtifact bundles a valid artifact", async () => {
  const path = writeArtifact(tempDir(), "overview", VALID_ARTIFACT);
  const result = await compileArtifact(path);
  expect(result.ok).toBe(true);
  expect(result.js).toContain("Overview");
  expect(result.js).toContain("Open issues");
  expect(result.js).toContain("createRoot");
});

test("compileArtifact rejects forbidden imports before bundling", async () => {
  const path = writeArtifact(tempDir(), "bad", FORBIDDEN_IMPORT_ARTIFACT);
  const result = await compileArtifact(path);
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0]?.message).toContain("node:fs");
});

test("compileArtifact rejects fetch", async () => {
  const path = writeArtifact(tempDir(), "fetch", FETCH_ARTIFACT);
  const result = await compileArtifact(path);
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some((item) => item.message.includes("fetch()"))).toBe(true);
});

test("compileArtifact bundles a relative artifact path", async () => {
  const result = await compileArtifact("examples/overview.artifact.tsx");
  expect(result.ok).toBe(true);
  expect(result.js).toContain("artifacts");
  expect(result.js).toContain("createRoot");
});

for (const specifier of ["sidequery/artifacts", "@sidequery/artifacts", "sidequery/canvas", "@sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
test(`SDK import ${specifier} typechecks and compiles ordinary React hooks`, async () => {
  const { HOOKS_ARTIFACT } = await import("./test/fixtures");
  const { typecheckArtifact } = await import("./typecheck");
    const path = writeArtifact(tempDir(), "hooks", HOOKS_ARTIFACT.replaceAll("sidequery/artifacts", specifier));
    expect(typecheckArtifact(path)).toEqual([]);
    const result = await compileArtifact(path);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
}, 30000);
}

for (const specifier of ["sidequery/canvas", "@sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
test(`historical SDK exports still typecheck and bundle from ${specifier}`, async () => {
  const { typecheckArtifact } = await import("./typecheck");
    const source = `import { useCanvasState, useCanvasAction, canvasFetch, canvasFiles, canvasPaletteDark, canvasPaletteLight, canvasTypography, MAX_CANVAS_FILE_BYTES, type CanvasAction, type SetCanvasState, type CanvasHttpRequest, type CanvasHttpResponse, type CanvasFile, type CanvasFileRequest, type CanvasFileResult, type CanvasFileList, type CanvasFileTransfer, type CanvasHostTheme, type CanvasPalette, type CanvasTokens } from "${specifier}";
export default function HistoricalCanvas() {
  const [count, setCount]: [number, SetCanvasState<number>] = useCanvasState("count", 0);
  return <button style={{color: canvasPaletteDark.foreground}} onClick={() => setCount(count + 1)}>{count} {MAX_CANVAS_FILE_BYTES} {typeof canvasFetch} {typeof canvasFiles} {typeof useCanvasAction} {typeof canvasPaletteLight} {typeof canvasTypography}</button>;
}`;
    const path = writeArtifact(tempDir(), "historical", source);
    expect(typecheckArtifact(path)).toEqual([]);
    const result = await compileArtifact(path);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
}, 30000);
}
