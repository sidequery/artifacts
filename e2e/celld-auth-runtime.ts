import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCelldConfig } from "../scripts/prepare-celld";

const root = resolve(import.meta.dir, "..");
const appDirectory = resolve(root, "dist/worker-app");
const assetsDirectory = resolve(root, "dist/cloudflare/assets");
const migrationsDirectory = resolve(root, "cloudflare/migrations");
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;

type RuntimeOptions = {
  port: number;
  bindings: Record<string, string>;
};

type RunningCelld = {
  process: ReturnType<typeof Bun.spawn>;
  logs: () => string;
  drained: Promise<void>;
};

function migrationNumber(name: string): bigint {
  const prefix = name.match(/^\d+/)?.[0];
  if (!prefix) throw new Error(`celld migration ${JSON.stringify(name)} has no numeric prefix`);
  return BigInt(prefix);
}

async function readMigrations() {
  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .sort((left, right) => {
      const byNumber = migrationNumber(left.name) < migrationNumber(right.name)
        ? -1
        : migrationNumber(left.name) > migrationNumber(right.name) ? 1 : 0;
      return byNumber || left.name.localeCompare(right.name);
    });
  return Promise.all(entries.map(async entry => ({
    name: entry.name,
    sql: await readFile(join(migrationsDirectory, entry.name), "utf8"),
  })));
}

async function writeMigrationWorker(project: string) {
  const migrations = await readMigrations();
  const source = `
const migrations = ${JSON.stringify(migrations)};
const quote = value => "'" + value.replaceAll("'", "''") + "'";

export default {
  async fetch(request, env) {
    if (request.method === "GET") return new Response("ready");
    if (request.method !== "POST") return new Response("POST only", { status: 405 });
    await env.AUTH_DB.exec('create table if not exists "d1_migrations" (id integer primary key autoincrement, name text unique, applied_at datetime not null default current_timestamp);');
    const applied = [];
    for (const migration of migrations) {
      const existing = await env.AUTH_DB.prepare('select name from "d1_migrations" where name = ?').bind(migration.name).first("name");
      if (existing !== null) continue;
      await env.AUTH_DB.exec(migration.sql + '\\ninsert into "d1_migrations" (name) values (' + quote(migration.name) + ');');
      applied.push(migration.name);
    }
    return Response.json({ applied });
  },
};
`;
  await writeFile(join(project, "migrate.js"), source);
  return migrations.map(migration => migration.name);
}

async function capture(stream: ReadableStream<Uint8Array> | number | undefined, append: (text: string) => void) {
  if (!(stream instanceof ReadableStream)) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const result = await reader.read();
    if (result.done) {
      append(decoder.decode());
      return;
    }
    append(decoder.decode(result.value, { stream: true }));
  }
}

function spawnCelld(binary: string, esbuild: string, project: string, port: number): RunningCelld {
  let output = "";
  const process = Bun.spawn({
    cmd: [binary, "dev", project, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
    cwd: project,
    env: { ...globalThis.process.env, CELLD_ESBUILD: esbuild, CELLD_WORKER_LOADER: "LOADER" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const append = (text: string) => { output += text; };
  const drained = Promise.all([capture(process.stdout, append), capture(process.stderr, append)]).then(() => undefined);
  return { process, logs: () => output, drained };
}

async function waitForReady(runtime: RunningCelld, url: string) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastResponse = "no HTTP response";
  while (Date.now() < deadline) {
    if (runtime.process.exitCode !== null) {
      await runtime.drained;
      throw new Error(`celld exited before readiness:\n${runtime.logs()}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastResponse = `HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`;
    } catch (error) {
      lastResponse = String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`celld did not become ready within ${START_TIMEOUT_MS}ms (${lastResponse}):\n${runtime.logs()}`);
}

async function stopCelld(runtime: RunningCelld | undefined) {
  if (!runtime) return;
  if (runtime.process.exitCode === null) runtime.process.kill("SIGINT");
  const stopped = await Promise.race([
    runtime.process.exited.then(() => true),
    Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    runtime.process.kill("SIGKILL");
    await runtime.process.exited;
  }
  await runtime.drained;
}

export async function startCelldAuthRuntime({ port, bindings }: RuntimeOptions): Promise<{ origin: string; logs: () => string; close: () => Promise<void> }> {
  const binary = globalThis.process.env.CELLD_BIN ?? Bun.which("celld");
  if (!binary) throw new Error("celld was not found; install celld or set CELLD_BIN to its executable");
  const esbuild = globalThis.process.env.CELLD_ESBUILD ?? resolve(root, "node_modules/.bin/esbuild");
  if (!existsSync(esbuild)) throw new Error(`esbuild was not found at ${esbuild}; run bun install or set CELLD_ESBUILD`);
  if (!existsSync(join(appDirectory, "worker.js"))) throw new Error("missing dist/worker-app/worker.js; run bun run build:cloudflare");
  if (!existsSync(assetsDirectory)) throw new Error("missing dist/cloudflare/assets; run bun run build:cloudflare");

  const project = await mkdtemp(join(tmpdir(), "artifact-celld-auth-"));
  const configPath = join(project, "wrangler.jsonc");
  const origin = `http://127.0.0.1:${port}`;
  let runtime: RunningCelld | undefined;
  let closed = false;

  try {
    await cp(appDirectory, join(project, "dist/worker-app"), { recursive: true });
    await cp(assetsDirectory, join(project, "dist/cloudflare/assets"), { recursive: true });
    await cp(migrationsDirectory, join(project, "cloudflare/migrations"), { recursive: true });
    const expectedMigrations = await writeMigrationWorker(project);
    const config = await prepareCelldConfig(resolve(root, "wrangler.jsonc"), configPath);
    config.d1_databases = [{
      binding: "AUTH_DB",
      database_name: "artifact-auth",
      migrations_dir: "cloudflare/migrations",
    }];
    config.vars = { ...(config.vars as Record<string, unknown> | undefined), ...bindings };
    await writeFile(configPath, `${JSON.stringify({
      name: config.name,
      main: "migrate.js",
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags,
      d1_databases: config.d1_databases,
    }, null, 2)}\n`);

    runtime = spawnCelld(binary, esbuild, project, port);
    await waitForReady(runtime, origin);
    const migrationResponse = await fetch(origin, { method: "POST" });
    const migrationResult = await migrationResponse.json() as { applied?: unknown };
    if (!migrationResponse.ok || JSON.stringify(migrationResult.applied) !== JSON.stringify(expectedMigrations)) {
      throw new Error(`celld D1 migration bootstrap failed (${migrationResponse.status}): ${JSON.stringify(migrationResult)}\n${runtime.logs()}`);
    }
    await stopCelld(runtime);
    runtime = undefined;

    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    runtime = spawnCelld(binary, esbuild, project, port);
    await waitForReady(runtime, `${origin}/health`);
  } catch (error) {
    await stopCelld(runtime);
    await rm(project, { recursive: true, force: true });
    throw error;
  }

  return {
    origin,
    logs: () => runtime?.logs() ?? "",
    async close() {
      if (closed) return;
      closed = true;
      await stopCelld(runtime);
      await rm(project, { recursive: true, force: true });
    },
  };
}
