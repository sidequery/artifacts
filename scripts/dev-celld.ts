import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const binary = process.env.CELLD_BIN ?? Bun.which("celld");
if (!binary) throw new Error("celld was not found; install celld or set CELLD_BIN to its executable");
const esbuild = process.env.CELLD_ESBUILD ?? resolve(root, "node_modules/.bin/esbuild");
if (!existsSync(esbuild)) throw new Error(`esbuild was not found at ${esbuild}; run bun install or set CELLD_ESBUILD`);

const child = Bun.spawn({
  cmd: [binary, "dev", resolve(root, "wrangler.celld.jsonc"), "--host", "127.0.0.1", "--port", process.env.CELLD_PORT ?? "4786"],
  cwd: root,
  env: { ...process.env, CELLD_ESBUILD: esbuild, CELLD_WORKER_LOADER: "LOADER" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const forward = (signal: "SIGINT" | "SIGTERM") => {
  if (child.exitCode === null) child.kill(signal);
};
const interrupt = () => forward("SIGINT");
const terminate = () => forward("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  process.exitCode = await child.exited;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
