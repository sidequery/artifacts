import { chmod, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { artifactDataRoot, ensureCelldRuntime } from "../../src/local/celld-runtime";
import { prepareCelldConfig } from "../../scripts/prepare-celld";
import { readConfig } from "./collector";

const root = resolve(import.meta.dir, "../..");

export function localOptions(env: NodeJS.ProcessEnv) {
  const config = readConfig({ RUNNER_ORG: env.RUNNER_ORG ?? "", RUNNER_REPOS: env.RUNNER_REPOS ?? "", RUNNER_NAME_PREFIX: env.RUNNER_NAME_PREFIX });
  const port = Number(env.RUNNER_PORT ?? "4786");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("RUNNER_PORT must be an integer between 1024 and 65535");
  return { config, port, directory: resolve(root, env.RUNNER_STATE_DIR ?? ".celld/runner-status") };
}

export async function seed(origin: string) {
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/api/tools`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as { isError?: boolean; structuredContent?: { ok?: boolean } };
    if (!response.ok || result.isError || result.structuredContent?.ok === false) throw new Error(`${name} failed; inspect the Artifact gallery`);
  }
  // Preserve edits and revision history when restarting an existing example.
  const source = await fetch(`${origin}/api/source?name=runner-status`);
  await source.body?.cancel();
  if (source.status === 404) {
    await call("artifact_guide", {});
    await call("artifact_write", { name: "runner-status", contents: await Bun.file(join(import.meta.dir, "runner-status.artifact.tsx")).text() });
  } else if (!source.ok) throw new Error("Unable to inspect existing artifact");
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await fetch(`${origin}/api/gallery?offset=${offset}`);
    if (!response.ok) throw new Error("Unable to inspect existing artifact link");
    const gallery = await response.json() as { artifacts: { name: string; kind?: string; slug?: string }[]; nextOffset: number | null };
    const existing = gallery.artifacts.find(item => item.name === "runner-status" && item.kind === "artifact");
    if (existing?.slug) return `${origin}/${existing.slug}`;
    if (existing) break;
    offset = gallery.nextOffset;
  }
  // Recover a first start interrupted between saving the source and linking it.
  await call("artifact_link", { kind: "artifact", name: "runner-status", slug: "runner-status", access: "private" });
  return `${origin}/runner-status`;
}

export async function main() {
  const { config, port, directory } = localOptions(process.env);
  // Fail before builds or state changes if another application owns this port.
  const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  listener.stop(true);
  let githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!githubToken) {
    if (!Bun.which("gh")) throw new Error("Set GITHUB_TOKEN or sign in with gh auth login");
    const auth = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], { stdout: "pipe", stderr: "ignore" });
    githubToken = (await new Response(auth.stdout).text()).trim();
    if (await auth.exited !== 0 || !githubToken) throw new Error("Set GITHUB_TOKEN or sign in with gh auth login");
  }
  const binary = process.env.CELLD_BIN ?? await ensureCelldRuntime({ dataRoot: artifactDataRoot(), notify: console.log });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Like artifacts server, hold a process-owned lock across builds and execution.
  // Different ports must not let two launchers rewrite the same native project.
  const lock = new Database(join(directory, "launcher-lock.sqlite"), { create: true });
  try { lock.exec("begin exclusive"); }
  catch { lock.close(); throw new Error(`A runner-status instance is already using ${directory}`); }
  const buildConfig = join(directory, "build.json");
  const runtimeConfig = join(directory, "wrangler.jsonc");
  const output = join(directory, "worker");
  const base = Bun.JSONC.parse(await Bun.file(join(root, "wrangler.jsonc")).text()) as {
    main: string; assets: { directory: string }; build: { command: string };
    durable_objects: { bindings: { name: string; class_name: string }[] };
    migrations: { tag: string; new_sqlite_classes: string[] }[];
  };
  base.main = join(import.meta.dir, "local.worker.ts");
  base.assets.directory = join(root, "dist/cloudflare/assets");
  base.build = { command: `bun run ${JSON.stringify(join(root, "scripts/prepare-cloudflare.ts"))}` };
  base.durable_objects.bindings.push({ name: "RUNNER_STATUS", class_name: "RunnerStatus" });
  base.migrations.push({ tag: "runner-status-v1", new_sqlite_classes: ["RunnerStatus"] });
  await writeFile(buildConfig, JSON.stringify(base, null, 2), { mode: 0o600 });

  // Build tools never receive the GitHub credential through our generated config.
  const environment: NodeJS.ProcessEnv = { ...process.env, ARTIFACTS_PLUGINS_CONFIG: join(import.meta.dir, "local.plugins.ts") };
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopping = false;
  const stop = () => { stopping = true; if (child?.exitCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  async function run(cmd: string[]) {
    if (stopping) throw new Error("Startup interrupted");
    child = Bun.spawn(cmd, { cwd: root, env: environment, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0 || stopping) throw new Error("Example build interrupted or failed");
  }
  try {
    await run(["bun", "run", "build:cloudflare-compiler"]);
    await run(["bun", "x", "wrangler", "deploy", "--dry-run", "--config", buildConfig, "--outdir", output]);
    await cp(base.assets.directory, join(directory, "assets"), { recursive: true });
    const runtime = await prepareCelldConfig(buildConfig, runtimeConfig, { main: "worker/local.worker.js", assets: "assets" });
    runtime.vars = {
      ...(runtime.vars as Record<string, unknown>),
      RUNNER_ORG: config.org, RUNNER_REPOS: config.repos.join(","), RUNNER_NAME_PREFIX: config.runnerPrefix,
      GITHUB_TOKEN: githubToken, RUNNER_STATUS_TOKEN: randomBytes(32).toString("hex"),
      RUNNER_STATUS_URL: `http://127.0.0.1:${port}/api/status`,
    };
    await chmod(runtimeConfig, 0o600);
    await writeFile(runtimeConfig, JSON.stringify(runtime), { mode: 0o600 });
    if (stopping) throw new Error("Startup interrupted");
    child = Bun.spawn([binary, "dev", runtimeConfig, "--host", "127.0.0.1", "--port", String(port), "--no-watch"], {
      cwd: directory, env: { ...environment, CELLD_ESBUILD: join(root, "node_modules/.bin/esbuild"), CELLD_WORKER_LOADER: "LOADER" },
      stdout: "inherit", stderr: "inherit",
    });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (!stopping && child.exitCode === null && Date.now() < deadline) {
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("celld failed to become ready");
    const url = await seed(origin);
    console.log(`Runner status: ${url}\nMonitoring ${config.org}: ${config.repos.join(", ")}\nState: ${directory}\nPress Ctrl-C to stop.`);
    const code = await child.exited;
    if (code !== 0 && !stopping) throw new Error(`celld exited (${code})`);
  } finally {
    stop();
    if (child) await child.exited;
    lock.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
