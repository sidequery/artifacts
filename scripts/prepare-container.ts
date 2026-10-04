import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { ensureCelldRuntime } from "../src/local/celld-runtime";
import { prepareCelldConfig } from "./prepare-celld";

const root = resolve(import.meta.dir, "..");
const output = join(root, "dist/container");
await mkdir(join(output, "bin"), { recursive: true });
// Reuse the release pin and both archive/executable checksums used by the CLI.
const celld = await ensureCelldRuntime({ dataRoot: join(output, "cache") });
const require = createRequire(import.meta.url);
const esbuildRequire = createRequire(require.resolve("esbuild/package.json"));
const esbuild = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
for (const [name, source] of Object.entries({ celld, esbuild })) {
  const destination = join(output, "bin", name);
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}
await prepareCelldConfig(join(root, "wrangler.jsonc"), join(output, "wrangler.jsonc"));
