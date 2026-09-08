import { createRequire } from "node:module";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./paths";
import { readLocalProject, writeLocalProject, localProjectPath } from "./localProject";
import { resolveProject } from "../cloudflare/project";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  artifactsDirFrom,
  artifactIdFromFile,
  ensureArtifactsDir,
  listArtifactFiles,
  resolveArtifactFile,
  assertRegularArtifact,
  replaceArtifactSource,
  ensureArtifactFileName,
} from "./artifactFile";
import { compileArtifact, type CompileResult } from "./compile";
import { formatArtifactCheck, type Diagnostic } from "./diagnostics";
import { createHerdrClient, type HerdrClient, type PanePlacement } from "./herdr";
import { openArtifact, type OpenResult } from "./open";
import { typecheckArtifact } from "./typecheck";
import { ArtifactHistory, historyPath, runtimeIdentity } from "./history";

export type ArtifactInfo = {
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

export type ArtifactEdit = { old_text: string; new_text: string };
export type ReadOptions = { file?: string; start_line?: number; end_line?: number };

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function projectFile(files: Record<string, string>, file: string): string {
  if (typeof file !== "string" || !Object.hasOwn(files, file)) throw new Error("project file not found; select a path returned by artifact_read.project.files");
  return files[file]!;
}

export type ArtifactServiceOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  artifactsDir?: string;
  herdr?: HerdrClient;
  inProcessServer?: boolean;
};

export class ArtifactService {
  readonly artifactsDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly herdr?: HerdrClient;
  readonly inProcessServer: boolean;

  constructor(opts: ArtifactServiceOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.artifactsDir = opts.artifactsDir ?? artifactsDirFrom(this.cwd, this.env);
    this.herdr = opts.herdr;
    this.inProcessServer = opts.inProcessServer ?? false;
  }

  list(): ArtifactInfo[] {
    return listArtifactFiles(this.artifactsDir).map((path) => ({
      id: artifactIdFromFile(path),
      path,
      name: basename(path),
    }));
  }

  resolve(input: string): string {
    return resolveArtifactFile(input, this.artifactsDir, this.cwd);
  }

  write(input: string, contents: string): WriteResult {
    ensureArtifactsDir(this.artifactsDir);
    const path = this.resolve(input);
    mkdirSync(this.artifactsDir, { recursive: true });
    let current: string | undefined;
    try { assertRegularArtifact(path); current = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    replaceArtifactSource(path, contents.endsWith("\n") ? contents : `${contents}\n`, current, "write");
    const diagnostics = typecheckArtifact(path);
    return {
      ok: diagnostics.length === 0,
      path,
      check: formatArtifactCheck(diagnostics),
      diagnostics,
    };
  }

  async writeProject(input: string, contents: string, project: unknown): Promise<WriteResult> {
    const path = this.resolve(input);
    const require = createRequire(join(PLUGIN_ROOT, "package.json"));
    const hostPackages = Object.fromEntries(["react", "react-dom", "react-router"].map(name => [name, require(`${name}/package.json`).version as string]));
    try { assertRegularArtifact(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const previousSource = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const previousProject = readLocalProject(path);
    const resolved = await resolveProject(project, previousProject, fetch, hostPackages);
    if ((existsSync(path) ? readFileSync(path, "utf8") : undefined) !== previousSource || JSON.stringify(readLocalProject(path)) !== JSON.stringify(previousProject)) {
      throw new Error("artifact changed while resolving dependencies; read it again before writing");
    }
    if (existsSync(path)) assertRegularArtifact(path);
    ensureArtifactsDir(this.artifactsDir);
    writeLocalProject(path, resolved);
    return this.write(input, contents);
  }

  read(input: string): string {
    return readFileSync(this.resolve(input), "utf8");
  }

  readRange(input: string, opts: ReadOptions = {}) {
    ensureArtifactFileName(input);
    const path = this.resolve(input);
    assertRegularArtifact(path);
    const project = readLocalProject(path);
    const source = opts.file === undefined ? readFileSync(path, "utf8") : projectFile(project.files, opts.file);
    // Keep line endings intact so returned source can be used in an exact edit.
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const start = opts.start_line === undefined ? 1 : opts.start_line;
    const end = opts.end_line === undefined ? start + 199 : opts.end_line;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) {
      throw new Error("line range must contain positive integers with end_line >= start_line");
    }
    if (start > Math.max(1, lines.length)) throw new Error("start_line is past the end of the artifact");
    const actualEnd = Math.min(end, lines.length);
    return {
      project, file: opts.file,
      path: opts.file ?? path, source_hash: sourceHash(source), total_lines: lines.length,
      start_line: start, end_line: actualEnd,
      source: lines.slice(start - 1, actualEnd).join(""),
      next_line: actualEnd < lines.length ? actualEnd + 1 : null,
    };
  }

  edit(input: string, edits: ArtifactEdit[], expectedHash?: string, file?: string) {
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must be a non-empty array");
    if (expectedHash !== undefined && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash))) {
      throw new Error("expected_hash must be a SHA-256 hex string");
    }
    ensureArtifactFileName(input);
    const path = this.resolve(input);
    assertRegularArtifact(path);
    const rawProject = file === undefined ? undefined : readFileSync(localProjectPath(path), "utf8");
    const project = readLocalProject(path);
    const original = file === undefined ? readFileSync(path, "utf8") : projectFile(project.files, file);
    if (expectedHash !== undefined && sourceHash(original) !== expectedHash) {
      throw new Error("artifact changed since read; read it again before editing");
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
    if (changed && file === undefined) replaceArtifactSource(path, source, original, "edit");
    if (changed && file !== undefined) {
      const updated = { ...project, files: { ...project.files, [file]: source } };
      replaceArtifactSource(localProjectPath(path), JSON.stringify(updated, null, 2) + "\n", rawProject, "project edit");
    }
    const diagnostics = typecheckArtifact(path);
    return {
      ok: diagnostics.length === 0, applied: true, changed, file, path: file ?? path,
      edits_applied: edits.length, source_hash: sourceHash(source),
      check: formatArtifactCheck(diagnostics), diagnostics,
    };
  }

  history(name?: string) {
    const archive = new ArtifactHistory(historyPath(this.env));
    try { return archive.list(this.artifactsDir, name ? artifactIdFromFile(this.resolve(name)) : undefined); }
    finally { archive.close(); }
  }

  version(id: string) {
    const archive = new ArtifactHistory(historyPath(this.env));
    try {
      const version = archive.version(id, this.artifactsDir);
      if (!version) throw new Error("version not found in this workspace");
      return { ...version, origin: archive.origin(version.artifact_id), events: archive.events(id) };
    } finally { archive.close(); }
  }

  remix(input: { name?: string; version_id?: string; new_name: string }) {
    if (typeof input.new_name !== "string") throw new Error("new_name must be a string");
    if ((input.name !== undefined) === (input.version_id !== undefined)) throw new Error("provide name or version_id, but not both");
    if (input.name !== undefined && typeof input.name !== "string") throw new Error("name must be a string");
    if (input.version_id !== undefined && (typeof input.version_id !== "string" || !input.version_id)) throw new Error("version_id must be a non-empty string");
    const path = this.resolve(ensureArtifactFileName(input.new_name));
    const name = artifactIdFromFile(path);
    const archive = new ArtifactHistory(historyPath(this.env));
    try {
      const revision = archive.db.transaction(() => {
        if (archive.db.query("select id from artifacts where workspace = ? and name = ?").get(resolve(this.artifactsDir), name)) {
          throw new Error("destination artifact already exists in history; choose a new name");
        }
        // Reject orphaned state and dangling links too: a remix always starts fresh.
        const destinations = [join(this.artifactsDir, `${name}.artifact.tsx`), join(this.artifactsDir, `${name}.canvas.tsx`)];
        for (const candidate of destinations.flatMap(source => [source, localProjectPath(source), source.replace(/\.tsx$/, ".data.json")])) {
          try { lstatSync(candidate); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          throw new Error("destination artifact or state already exists; choose a new name");
        }
        const runtime = runtimeIdentity();
        let sourceVersion;
        if (input.version_id !== undefined) {
          sourceVersion = archive.version(input.version_id, this.artifactsDir);
          if (!sourceVersion) throw new Error("version not found in this workspace");
        } else {
          ensureArtifactFileName(input.name!);
          const sourcePath = this.resolve(input.name!);
          assertRegularArtifact(sourcePath);
          sourceVersion = archive.capture({ workspace: this.artifactsDir, name: artifactIdFromFile(sourcePath), sourcePath,
            source: readFileSync(sourcePath, "utf8"), runtime, reason: "before-remix" });
        }
        const version = archive.capture({ workspace: this.artifactsDir, name, sourcePath: path,
          source: sourceVersion.source, project: sourceVersion.project, runtime, reason: "remix" });
        archive.db.query("insert into artifact_remixes values (?, ?)").run(version.artifact_id, sourceVersion.id);
        ensureArtifactsDir(this.artifactsDir);
        // Exclusive creation never follows or replaces a competing destination link/file.
        writeLocalProject(path, sourceVersion.project!, true);
        try { writeFileSync(path, sourceVersion.source, { flag: "wx" }); }
        catch (error) { unlinkSync(localProjectPath(path)); throw error; }
        return version;
      }).immediate();
      const diagnostics = typecheckArtifact(path);
      return { ok: diagnostics.length === 0, remixed: true, name, path, versionId: revision.id,
        origin: archive.origin(revision.artifact_id), check: formatArtifactCheck(diagnostics), diagnostics };
    } finally { archive.close(); }
  }

  restore(id: string) {
    const archive = new ArtifactHistory(historyPath(this.env));
    try {
      const target = archive.version(id, this.artifactsDir);
      if (!target) throw new Error("version not found in this workspace");
      let path = resolveArtifactFile(target.name, this.artifactsDir, this.cwd);
      // A deleted legacy source must be recreated next to its original sidecars.
      if (!existsSync(path) && dirname(resolve(target.source_path)) === resolve(this.artifactsDir) && artifactIdFromFile(target.source_path) === target.name) {
        path = resolve(target.source_path);
      }
      const runtime = runtimeIdentity();
      // Commit the working copy to history before overwriting it, including invalid drafts.
      let current: string | undefined;
      if (existsSync(path)) {
        assertRegularArtifact(path);
        current = readFileSync(path, "utf8");
        archive.capture({ workspace: this.artifactsDir, name: target.name, sourcePath: path, source: current, runtime, reason: "before-restore" });
      }
      ensureArtifactsDir(this.artifactsDir);
      replaceArtifactSource(path, target.source, current);
      writeLocalProject(path, target.project!);
      const revision = archive.capture({ workspace: this.artifactsDir, name: target.name, sourcePath: path, source: target.source, runtime, reason: "restore", restoredFrom: id, force: true });
      const diagnostics = typecheckArtifact(path);
      return { ok: diagnostics.length === 0, restored: true, path, versionId: revision.id, revision: revision.revision, check: formatArtifactCheck(diagnostics), diagnostics };
    } finally { archive.close(); }
  }

  typecheck(input: string): { check: string; diagnostics: Diagnostic[]; path: string } {
    const path = this.resolve(input);
    const diagnostics = typecheckArtifact(path);
    return { path, diagnostics, check: formatArtifactCheck(diagnostics) };
  }

  async compile(input: string): Promise<CompileResult & { path: string; check: string }> {
    const path = this.resolve(input);
    const result = await compileArtifact(path);
    return { ...result, path, check: formatArtifactCheck(result.diagnostics) };
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
    const result = await openArtifact(path, {
      artifactsDir: this.artifactsDir,
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
