import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const ARTIFACTS_SUFFIX = ".artifact.tsx";

export const LEGACY_ARTIFACT_SUFFIX = ".canvas.tsx";

export function artifactsDirFrom(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARTIFACTS_DIR || env.HERDR_CANVAS_DIR) {
    return resolve(env.ARTIFACTS_DIR || env.HERDR_CANVAS_DIR!);
  }
  const worktree = worktreeFromEnv(env);
  const root = worktree ?? resolve(cwd);
  const current = join(root, "artifacts"), legacy = join(root, "canvases");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function worktreeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) {
    return env.HERDR_WORKTREE ?? undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      worktree?: { path?: string } | string;
      workspace?: { path?: string };
    };
    if (typeof parsed.worktree === "string") {
      return parsed.worktree;
    }
    if (parsed.worktree?.path) {
      return parsed.worktree.path;
    }
    if (parsed.workspace?.path) {
      return parsed.workspace.path;
    }
  } catch {
    return undefined;
  }
  return env.HERDR_WORKTREE ?? undefined;
}

export function artifactIdFromFile(filePath: string): string {
  const name = basename(filePath);
  const suffix = name.endsWith(LEGACY_ARTIFACT_SUFFIX) ? LEGACY_ARTIFACT_SUFFIX : ARTIFACTS_SUFFIX;
  if (!name.endsWith(suffix)) {
    throw new Error(`not a artifact file: ${filePath}`);
  }
  return name.slice(0, -suffix.length);
}

export function ensureArtifactFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new Error("artifact name is required");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("artifact names cannot contain slashes");
  }
  return (trimmed.endsWith(ARTIFACTS_SUFFIX) || trimmed.endsWith(LEGACY_ARTIFACT_SUFFIX)) ? trimmed : `${trimmed}${ARTIFACTS_SUFFIX}`;
}

export function resolveArtifactFile(input: string, artifactsDir: string, cwd = process.cwd()): string {
  const expanded = input.startsWith("~")
    ? join(process.env.HOME ?? "", input.slice(1))
    : input;
  if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) {
    return resolve(cwd, expanded);
  }
  const canonical = join(artifactsDir, ensureArtifactFileName(expanded));
  if (expanded.endsWith(ARTIFACTS_SUFFIX) || expanded.endsWith(LEGACY_ARTIFACT_SUFFIX)) return canonical;
  const legacy = join(artifactsDir, `${expanded.trim()}${LEGACY_ARTIFACT_SUFFIX}`);
  if (existsSync(canonical) && existsSync(legacy)) throw new Error(`ambiguous artifact name: ${expanded}; specify the full source filename`);
  return existsSync(legacy) ? legacy : canonical;
}

export function listArtifactFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(ARTIFACTS_SUFFIX) || name.endsWith(LEGACY_ARTIFACT_SUFFIX))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
      .sort();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function ensureArtifactsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function assertRegularArtifact(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("artifact source must be a regular file, not a symlink");
}

export function replaceArtifactSource(path: string, source: string, expectedSource: string | undefined, operation = "restore"): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o666;
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    let current: string | undefined;
    try {
      assertRegularArtifact(path);
      current = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== expectedSource) throw new Error(`artifact changed during ${operation}; working file left untouched, retry after reviewing the edit`);
    // Atomic replacement avoids truncating the working file on a failed/partial write.
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
