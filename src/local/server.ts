import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactDataRoot, ensureCelldRuntime } from "./celld-runtime";
import { PLUGIN_ROOT } from "../paths";

export async function runCelldServer(options: { port?: number; stateDir?: string; signal: AbortSignal; onReady?: (url: string) => void | Promise<void> }): Promise<void> {
  const port = options.port ?? 4786;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("server --port must be an integer between 1 and 65535");
  const dataRoot = artifactDataRoot();
  const project = resolve(options.stateDir ?? join(dataRoot, "server"));
  let template: Record<string, any>;
  try { template = JSON.parse(await readFile(join(PLUGIN_ROOT, "dist/celld/wrangler.jsonc"), "utf8")); }
  catch { throw new Error("Packaged Artifact server assets are missing. From a source checkout, run bun run build:package first."); }
  await mkdir(project, { recursive: true, mode: 0o700 });
  // A held SQLite write transaction excludes a second launcher and releases on
  // process death, so stale PID files cannot prevent recovery after a crash.
  const lock = new Database(join(project, "server-lock.sqlite"), { create: true });
  try { lock.exec("begin exclusive"); }
  catch { lock.close(); throw new Error(`An Artifact server is already using ${project}`); }
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let drained: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    if (!child || child.exitCode !== null) return Promise.resolve();
    const running = child;
    stopping = (async () => {
      running.kill("SIGINT");
      const timeout = setTimeout(() => { if (running.exitCode === null) running.kill("SIGKILL"); }, 45_000);
      try { await running.exited; } finally { clearTimeout(timeout); }
    })();
    return stopping;
  };
  const abort = () => { void stop(); };
  options.signal.addEventListener("abort", abort);
  try {
    options.signal.throwIfAborted();
    // Check before a first-use download; celld must own this exact listener.
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
    const executable = await ensureCelldRuntime({ dataRoot, signal: options.signal, notify: message => console.error(message) });
    // This directory contains only reproducible package output, never user data.
    // Removing it prevents deleted assets from a previous version remaining served.
    await rm(join(project, "dist"), { recursive: true, force: true });
    for (const directory of ["worker-app", "cloudflare"]) {
      await cp(join(PLUGIN_ROOT, "dist", directory), join(project, "dist", directory), { recursive: true });
    }
    // Keep the project path stable across package versions: celld derives local
    // node identity from it. Its .celld/dev directory is durable, never replaced.
    template.main = "dist/worker-app/worker.js";
    template.assets.directory = "dist/cloudflare/assets";
    await writeFile(join(project, "wrangler.jsonc"), JSON.stringify(template, null, 2) + "\n");
    options.signal.throwIfAborted();
    const require = createRequire(import.meta.url);
    // esbuild/bin/esbuild may be a Node-shebang wrapper. A launchd/systemd
    // environment need not have Node (or Bun) on PATH; use the installed native
    // optional dependency directly, resolved from esbuild even when nested.
    const esbuildRequire = createRequire(require.resolve("esbuild/package.json"));
    const esbuild = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
    child = Bun.spawn([executable, "dev", project, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"], {
      cwd: project,
      env: { ...process.env, CELLD_ESBUILD: esbuild, CELLD_WORKER_LOADER: "LOADER", CELLD_IDLE_EVICT_S: process.env.CELLD_IDLE_EVICT_S ?? "60", RUST_LOG: process.env.RUST_LOG ?? "warn" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const forward = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
      if (!(stream instanceof ReadableStream)) return;
      for await (const chunk of stream) process.stderr.write(chunk);
    };
    drained = Promise.all([forward(child.stdout), forward(child.stderr)]);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      options.signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error(`celld exited during startup (${child.exitCode})`);
      try { const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("celld did not become ready within 45 seconds");
    await options.onReady?.(origin);
    const code = await child.exited;
    if (code !== 0 && !options.signal.aborted) throw new Error(`celld exited (${code})`);
  } finally {
    options.signal.removeEventListener("abort", abort);
    await stop();
    await drained;
    lock.close();
  }
}
