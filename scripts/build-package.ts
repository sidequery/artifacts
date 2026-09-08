import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { prepareCelldConfig } from "./prepare-celld";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const usePrebuiltWorker = process.argv.includes("--prebuilt-worker");
// The optional collector is compiled only while building a release. Its plugin
// preparation writes shared build intermediates, so always build core afterwards.
if (!usePrebuiltWorker) {
  const runner = Bun.spawn([process.execPath, "run", "examples/runner-status/local.ts", "--prepare-only"], {
    cwd: root, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CELLD_BIN: "/unused-during-prepare", RUNNER_ORG: "example", RUNNER_REPOS: "example/repo", RUNNER_STATE_DIR: join(dist, "runner-status") },
  });
  if (await runner.exited !== 0) throw new Error("Runner status package build failed");
  await cp(join(root, "examples/runner-status/runner-status.artifact.tsx"), join(dist, "runner-status/runner-status.artifact.tsx"));
  // Build-only scaffolding and lock files are not release artifacts.
  for (const file of ["build.json", "launcher-lock.sqlite"]) await rm(join(dist, "runner-status", file), { force: true });
}
const service = await Bun.build({ entrypoints: [join(root, "src/local/host-service.ts")], target: "bun", format: "esm", outdir: join(dist, "host"), naming: "service.js" });
if (!service.success) throw new Error(service.logs.join("\n"));
if (!usePrebuiltWorker) {
  for (const directory of ["celld", "cloudflare", "worker-app"]) {
    await rm(join(dist, directory), { recursive: true, force: true });
  }

  const build = Bun.spawn([process.execPath, "run", "build:cloudflare"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited !== 0) throw new Error("Cloudflare package build failed");
}

const celldDirectory = join(dist, "celld");
await mkdir(celldDirectory, { recursive: true });
await prepareCelldConfig(join(root, "wrangler.jsonc"), join(celldDirectory, "wrangler.jsonc"), {
  main: "../worker-app/worker.js",
  assets: "../cloudflare/assets",
});

for (const path of [
  "host/service.js",
  "runner-status/wrangler.jsonc",
  "runner-status/worker/local.worker.js",
  "runner-status/assets/index.html",
  "runner-status/runner-status.artifact.tsx",
  "celld/wrangler.jsonc",
  "cloudflare/assets/index.html",
  "cloudflare/compiler-files.json",
  "worker-app/worker.js",
]) {
  const file = await stat(join(dist, path));
  if (!file.isFile() || file.size === 0) throw new Error(`Missing package artifact: dist/${path}`);
}

console.log("Prepared package artifacts in dist/{celld,cloudflare,worker-app}");
