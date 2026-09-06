import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const CANVAS_SUFFIX = ".canvas.tsx";

export function canvasesDirFrom(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_CANVAS_DIR) {
    return resolve(env.HERDR_CANVAS_DIR);
  }
  const worktree = worktreeFromEnv(env);
  return join(worktree ?? resolve(cwd), "canvases");
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

export function canvasIdFromFile(filePath: string): string {
  const name = basename(filePath);
  if (!name.endsWith(CANVAS_SUFFIX)) {
    throw new Error(`not a canvas file: ${filePath}`);
  }
  return name.slice(0, -CANVAS_SUFFIX.length);
}

export function ensureCanvasFileName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new Error("canvas name is required");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("canvas names cannot contain slashes");
  }
  return trimmed.endsWith(CANVAS_SUFFIX) ? trimmed : `${trimmed}${CANVAS_SUFFIX}`;
}

export function resolveCanvasFile(input: string, canvasesDir: string, cwd = process.cwd()): string {
  const expanded = input.startsWith("~")
    ? join(process.env.HOME ?? "", input.slice(1))
    : input;
  if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) {
    return resolve(cwd, expanded);
  }
  return join(canvasesDir, ensureCanvasFileName(expanded));
}

export function listCanvasFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(CANVAS_SUFFIX))
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

export function ensureCanvasesDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function assertRegularCanvas(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error("canvas source must be a regular file, not a symlink");
}

export function replaceCanvasSource(path: string, source: string, expectedSource: string | undefined, operation = "restore"): void {
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
      assertRegularCanvas(path);
      current = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== expectedSource) throw new Error(`canvas changed during ${operation}; working file left untouched, retry after reviewing the edit`);
    // Atomic replacement avoids truncating the working file on a failed/partial write.
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
