import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactDataRoot } from "./celld-runtime";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Publish a complete, versioned runtime tree; saved Canvas data stays elsewhere. */
export async function extractStandalonePackage(payload: Uint8Array, expectedHash: string, dataRoot: string): Promise<string> {
  if (digest(payload) !== expectedHash) throw new Error("Embedded Canvas package checksum mismatch");
  const packages = join(dataRoot, "packages");
  const destination = join(packages, expectedHash);
  const complete = join(destination, "complete");
  try {
    if (await readFile(complete, "utf8") === expectedHash) return join(destination, "package");
    throw new Error("Incomplete Canvas package cache");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(packages, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(packages, ".extract-"));
  try {
    await new Bun.Archive(payload).extract(temporary);
    const root = join(temporary, "package");
    for (const path of ["src/cli.ts", "package.json", "native/celld", "native/esbuild"]) {
      if (!(await Bun.file(join(root, path)).exists())) throw new Error(`Embedded Canvas package is missing ${path}`);
    }
    await chmod(join(root, "native/celld"), 0o700);
    await chmod(join(root, "native/esbuild"), 0o700);
    await writeFile(join(temporary, "complete"), expectedHash, { mode: 0o600 });
    try { await rename(temporary, destination); }
    catch (error) {
      // Another invocation may have finished extracting this exact payload.
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || await readFile(complete, "utf8") !== expectedHash) throw error;
    }
    return join(destination, "package");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Bun's documented interpreter mode lets the embedded runtime execute the same
 * package entrypoint as bun installations, including filesystem-based compilers. */
export async function runStandalone(payload: Uint8Array, expectedHash: string) {
  const root = await extractStandalonePackage(payload, expectedHash, artifactDataRoot());
  const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), ...process.argv.slice(2)], {
    env: {
      ...process.env, BUN_BE_BUN: "1", ARTIFACTS_STANDALONE_EXECUTABLE: process.execPath,
      ARTIFACTS_BUNDLED_CELLD: join(root, "native/celld"), ARTIFACTS_BUNDLED_ESBUILD: join(root, "native/esbuild"),
    },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const interrupt = () => { if (child.exitCode === null) child.kill("SIGINT"); };
  const terminate = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { process.exitCode = await child.exited; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
