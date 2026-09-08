import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { prepareCelldConfig } from "./prepare-celld";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const usePrebuiltWorker = process.argv.includes("--prebuilt-worker");
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
  "celld/wrangler.jsonc",
  "cloudflare/assets/index.html",
  "cloudflare/compiler-files.json",
  "worker-app/worker.js",
]) {
  const file = await stat(join(dist, path));
  if (!file.isFile() || file.size === 0) throw new Error(`Missing package artifact: dist/${path}`);
}

console.log("Prepared package artifacts in dist/{celld,cloudflare,worker-app}");
