import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ArtifactService, type ArtifactEdit } from "./service";
import { replaceArtifactSource } from "./artifactFile";
import { VALID_ARTIFACT, tempDir, writeArtifact } from "./test/fixtures";

test("read ranges preserve CRLF and final lines, paginate and hash the entire source", () => {
  const dir = tempDir();
  const source = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join("\r\n");
  writeArtifact(dir, "overview", source);
  const service = new ArtifactService({ artifactsDir: dir });
  const first = service.readRange("overview");
  expect(first).toMatchObject({ start_line: 1, end_line: 200, total_lines: 205, next_line: 201 });
  const last = service.readRange("overview", { start_line: 201 });
  expect(first.source + last.source).toBe(source);
  expect(last.source_hash).toBe(first.source_hash);
  expect(last).toMatchObject({ end_line: 205, next_line: null });
  expect(service.readRange("overview", { start_line: 2, end_line: 2 }).source).toBe("line 2\r\n");
  expect(service.readRange("overview", { end_line: 999 }).source).toBe(source);
  for (const options of [{ start_line: 0 }, { end_line: 1.5 }, { start_line: 3, end_line: 2 }, { start_line: 206 }, { start_line: NaN }]) {
    expect(() => service.readRange("overview", options)).toThrow();
  }
  writeArtifact(dir, "empty", "");
  expect(service.readRange("empty")).toMatchObject({ source: "", total_lines: 0, end_line: 0, next_line: null });
  writeArtifact(dir, "blank", "\n");
  expect(service.readRange("blank")).toMatchObject({ source: "\n", total_lines: 1 });
});

test("edit applies a guarded sequential batch, supports deletion, and returns no source", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const service = new ArtifactService({ artifactsDir: dir });
  const before = service.readRange("overview");
  const result = service.edit("overview", [
    { old_text: "<H1>Overview</H1>", new_text: "<H1>Draft</H1>" },
    { old_text: "<H1>Draft</H1>", new_text: "<H1>Final</H1>" },
    { old_text: "      <Text>Embedded sample data.</Text>\n", new_text: "" },
  ], before.source_hash);
  expect(result).toMatchObject({ ok: true, applied: true, changed: true, edits_applied: 3, diagnostics: [] });
  expect(result).not.toHaveProperty("source");
  expect(result.source_hash).not.toBe(before.source_hash);
  expect(readFileSync(path, "utf8")).toBe(VALID_ARTIFACT.replace("<H1>Overview</H1>", "<H1>Final</H1>").replace("      <Text>Embedded sample data.</Text>\n", ""));
  expect(() => service.edit("overview", [{ old_text: "Final", new_text: "Stale" }], before.source_hash)).toThrow("changed since read");
  expect(service.readRange("overview").source_hash).toBe(result.source_hash);
}, { timeout: 30_000 });

test("invalid edit batches never partially write, including overlapping ambiguity", () => {
  const dir = tempDir();
  const source = VALID_ARTIFACT + "// aaa\n";
  const path = writeArtifact(dir, "overview", source);
  const service = new ArtifactService({ artifactsDir: dir });
  const batches: unknown[] = [[], null, {}, [{ old_text: "", new_text: "x" }], [{ old_text: "Overview", new_text: "x" }],
    [{ old_text: "aa", new_text: "x" }], [{ old_text: "missing", new_text: "x" }], [{ old_text: "return" }],
    [{ old_text: "<H1>Overview</H1>", new_text: "<H1>Changed</H1>" }, { old_text: "missing", new_text: "x" }]];
  for (const batch of batches) {
    expect(() => service.edit("overview", batch as ArtifactEdit[])).toThrow();
    expect(readFileSync(path, "utf8")).toBe(source);
  }
  expect(() => service.edit("overview", [{ old_text: "return", new_text: "return" }], "bad")).toThrow("SHA-256");
});

test("edit reports no-ops and leaves invalid resulting TSX applied with diagnostics", () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const service = new ArtifactService({ artifactsDir: dir });
  const noOp = service.edit("overview", [{ old_text: "gap={16}", new_text: "gap={16}" }]);
  expect(noOp).toMatchObject({ ok: true, applied: true, changed: false });
  const invalid = service.edit("overview", [{ old_text: "gap={16}", new_text: 'gap="wide"' }]);
  expect(invalid).toMatchObject({ ok: false, applied: true, changed: true });
  expect(invalid.diagnostics.length).toBeGreaterThan(0);
  expect(readFileSync(path, "utf8")).toContain('gap="wide"');
}, { timeout: 30_000 });

test("read and edit reject missing, path and symlink targets; replacement detects changed source", () => {
  const dir = tempDir();
  const outside = writeArtifact(tempDir(), "outside", VALID_ARTIFACT);
  symlinkSync(outside, join(dir, "linked.artifact.tsx"));
  const service = new ArtifactService({ artifactsDir: dir });
  const edits = [{ old_text: "return", new_text: "return" }];
  for (const name of ["missing", "linked", outside, "../outside"]) {
    expect(() => service.readRange(name)).toThrow();
    expect(() => service.edit(name, edits)).toThrow();
  }
  expect(readFileSync(outside, "utf8")).toBe(VALID_ARTIFACT);
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  writeFileSync(path, "concurrent edit");
  expect(() => replaceArtifactSource(path, "replacement", VALID_ARTIFACT, "edit")).toThrow("changed during edit");
  expect(readFileSync(path, "utf8")).toBe("concurrent edit");
  expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
