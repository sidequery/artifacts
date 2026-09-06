import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

import {
  canvasesDirFrom,
  canvasIdFromFile,
  ensureCanvasesDir,
  listCanvasFiles,
  resolveCanvasFile,
  assertRegularCanvas,
  replaceCanvasSource,
  ensureCanvasFileName,
} from "./canvasFile";
import { compileCanvas, type CompileResult } from "./compile";
import { formatCanvasCheck, type Diagnostic } from "./diagnostics";
import { createHerdrClient, type HerdrClient, type PanePlacement } from "./herdr";
import { openCanvas, type OpenResult } from "./open";
import { typecheckCanvas } from "./typecheck";
import { CanvasHistory, historyPath, runtimeIdentity } from "./history";

export type CanvasInfo = {
  id: string;
  path: string;
  name: string;
};

export type WriteResult = {
  ok: boolean;
  path: string;
  check: string;
  diagnostics: Diagnostic[];
};

export type CanvasEdit = { old_text: string; new_text: string };
export type ReadOptions = { start_line?: number; end_line?: number };

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export type CanvasServiceOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  canvasesDir?: string;
  herdr?: HerdrClient;
  inProcessServer?: boolean;
};

export class CanvasService {
  readonly canvasesDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly herdr?: HerdrClient;
  readonly inProcessServer: boolean;

  constructor(opts: CanvasServiceOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.canvasesDir = opts.canvasesDir ?? canvasesDirFrom(this.cwd, this.env);
    this.herdr = opts.herdr;
    this.inProcessServer = opts.inProcessServer ?? false;
  }

  list(): CanvasInfo[] {
    return listCanvasFiles(this.canvasesDir).map((path) => ({
      id: canvasIdFromFile(path),
      path,
      name: basename(path),
    }));
  }

  resolve(input: string): string {
    return resolveCanvasFile(input, this.canvasesDir, this.cwd);
  }

  write(input: string, contents: string): WriteResult {
    ensureCanvasesDir(this.canvasesDir);
    const path = this.resolve(input);
    mkdirSync(this.canvasesDir, { recursive: true });
    writeFileSync(path, contents.endsWith("\n") ? contents : `${contents}\n`);
    const diagnostics = typecheckCanvas(path);
    return {
      ok: diagnostics.length === 0,
      path,
      check: formatCanvasCheck(diagnostics),
      diagnostics,
    };
  }

  read(input: string): string {
    return readFileSync(this.resolve(input), "utf8");
  }

  readRange(input: string, opts: ReadOptions = {}) {
    const path = this.resolve(ensureCanvasFileName(input));
    assertRegularCanvas(path);
    const source = readFileSync(path, "utf8");
    // Keep line endings intact so returned source can be used in an exact edit.
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const start = opts.start_line === undefined ? 1 : opts.start_line;
    const end = opts.end_line === undefined ? start + 199 : opts.end_line;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) {
      throw new Error("line range must contain positive integers with end_line >= start_line");
    }
    if (start > Math.max(1, lines.length)) throw new Error("start_line is past the end of the canvas");
    const actualEnd = Math.min(end, lines.length);
    return {
      path, source_hash: sourceHash(source), total_lines: lines.length,
      start_line: start, end_line: actualEnd,
      source: lines.slice(start - 1, actualEnd).join(""),
      next_line: actualEnd < lines.length ? actualEnd + 1 : null,
    };
  }

  edit(input: string, edits: CanvasEdit[], expectedHash?: string) {
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must be a non-empty array");
    if (expectedHash !== undefined && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash))) {
      throw new Error("expected_hash must be a SHA-256 hex string");
    }
    const path = this.resolve(ensureCanvasFileName(input));
    assertRegularCanvas(path);
    const original = readFileSync(path, "utf8");
    if (expectedHash !== undefined && sourceHash(original) !== expectedHash) {
      throw new Error("canvas changed since read; read it again before editing");
    }
    let source = original;
    for (const [index, edit] of edits.entries()) {
      if (!edit || typeof edit.old_text !== "string" || edit.old_text.length === 0 || typeof edit.new_text !== "string") {
        throw new Error(`edit ${index + 1}: old_text must be non-empty and new_text must be a string`);
      }
      const at = source.indexOf(edit.old_text);
      if (at === -1) throw new Error(`edit ${index + 1}: old_text not found; no changes written`);
      if (source.indexOf(edit.old_text, at + 1) !== -1) throw new Error(`edit ${index + 1}: old_text is ambiguous; include more context; no changes written`);
      source = source.slice(0, at) + edit.new_text + source.slice(at + edit.old_text.length);
    }
    const changed = source !== original;
    if (changed) replaceCanvasSource(path, source, original, "edit");
    const diagnostics = typecheckCanvas(path);
    return {
      ok: diagnostics.length === 0, applied: true, changed, path,
      edits_applied: edits.length, source_hash: sourceHash(source),
      check: formatCanvasCheck(diagnostics), diagnostics,
    };
  }

  history(name?: string) {
    const archive = new CanvasHistory(historyPath(this.env));
    try { return archive.list(this.canvasesDir, name ? canvasIdFromFile(this.resolve(name)) : undefined); }
    finally { archive.close(); }
  }

  version(id: string) {
    const archive = new CanvasHistory(historyPath(this.env));
    try {
      const version = archive.version(id, this.canvasesDir);
      if (!version) throw new Error("version not found in this workspace");
      return { ...version, events: archive.events(id) };
    } finally { archive.close(); }
  }

  restore(id: string) {
    const archive = new CanvasHistory(historyPath(this.env));
    try {
      const target = archive.version(id, this.canvasesDir);
      if (!target) throw new Error("version not found in this workspace");
      const path = resolveCanvasFile(target.name, this.canvasesDir, this.cwd);
      const runtime = runtimeIdentity();
      // Commit the working copy to history before overwriting it, including invalid drafts.
      let current: string | undefined;
      if (existsSync(path)) {
        assertRegularCanvas(path);
        current = readFileSync(path, "utf8");
        archive.capture({ workspace: this.canvasesDir, name: target.name, sourcePath: path, source: current, runtime, reason: "before-restore" });
      }
      ensureCanvasesDir(this.canvasesDir);
      replaceCanvasSource(path, target.source, current);
      const revision = archive.capture({ workspace: this.canvasesDir, name: target.name, sourcePath: path, source: target.source, runtime, reason: "restore", restoredFrom: id, force: true });
      const diagnostics = typecheckCanvas(path);
      return { ok: diagnostics.length === 0, restored: true, path, versionId: revision.id, revision: revision.revision, check: formatCanvasCheck(diagnostics), diagnostics };
    } finally { archive.close(); }
  }

  typecheck(input: string): { check: string; diagnostics: Diagnostic[]; path: string } {
    const path = this.resolve(input);
    const diagnostics = typecheckCanvas(path);
    return { path, diagnostics, check: formatCanvasCheck(diagnostics) };
  }

  async compile(input: string): Promise<CompileResult & { path: string; check: string }> {
    const path = this.resolve(input);
    const result = await compileCanvas(path);
    return { ...result, path, check: formatCanvasCheck(result.diagnostics) };
  }

  async open(
    input: string,
    opts: {
      placement?: PanePlacement;
      direction?: "right" | "down";
      focus?: boolean;
      skipOpen?: boolean;
      versionId?: string;
      eventId?: string;
    } = {},
  ): Promise<OpenResult & { path: string }> {
    const path = opts.versionId ? this.version(opts.versionId).source_path : this.resolve(input);
    const result = await openCanvas(path, {
      canvasesDir: this.canvasesDir,
      herdr: this.herdr ?? createHerdrClient(this.env),
      env: this.env,
      inProcessServer: this.inProcessServer,
      versionId: opts.versionId,
      eventId: opts.eventId,
      placement: opts.placement,
      direction: opts.direction,
      focus: opts.focus,
      skipOpen: opts.skipOpen,
    });
    return { ...result, path };
  }
}
