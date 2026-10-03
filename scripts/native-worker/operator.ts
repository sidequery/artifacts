import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { artifactDataRoot, CELLD_VERSION, ensureCelldRuntime } from "../../src/local/celld-runtime";
import { parseManifest, type ResourceLedger } from "../../cloudflare/native-worker/manifest";
import { classAlias, resourceName, workerName, type NativeDeployment, type ProviderResult } from "../../cloudflare/native-worker/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESOURCE_TYPES = new Set(["durable-object", "kv", "r2", "d1", "queue"]);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

// celld dev deliberately disables forwarded host/protocol trust. This adapter
// restores a URL supplied by the authenticated operator, not an auth capability.
// Native bindings, named exports, and non-HTTP event handlers remain native.
const routingAdapter = `import app from "./app.js";
export * from "./app.js";
function restoreRequest(request) {
  const target = request.headers.get("x-artifacts-target-url");
  if (!target) throw new Error("Missing operator target URL");
  const headers = new Headers(request.headers);
  headers.delete("x-artifacts-target-url");
  headers.set("host", new URL(target).host);
  return new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" });
}
const routed = typeof app === "function"
  ? class extends app {
      fetch(request, ...args) { return super.fetch(restoreRequest(request), ...args); }
    }
  : Object.assign(Object.create(app), {
      fetch(request, ...args) { return app.fetch(restoreRequest(request), ...args); }
    });
export default routed;
`;

type SavedDeployment = Omit<NativeDeployment, "secrets"> & { secretFile: string };
type Journal = { active?: SavedDeployment; desired?: SavedDeployment; resources: ResourceLedger };
type RuntimeRecord = { pid: number; command: string[]; port: number };
type Runtime = { child: ReturnType<typeof Bun.spawn>; record: RuntimeRecord; stopping: boolean; ready: boolean };
type Options = {
  root: string;
  token: string;
  binary?: string;
  esbuild?: string;
  startupTimeoutMs?: number;
};

class InvalidDeployment extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDeployment(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function validateDeployment(value: unknown): NativeDeployment {
  const input = object(value, "deployment");
  if (typeof input.app !== "string" || !UUID.test(input.app)) throw new InvalidDeployment("Invalid app UUID");
  const revision = object(input.revision, "revision");
  if (typeof revision.id !== "string" || !HASH.test(revision.id)) throw new InvalidDeployment("Invalid revision ID");
  if (typeof revision.source !== "string" || typeof revision.code !== "string" || !revision.code.trim()
    || revision.source.length > 4 * 1024 * 1024 || revision.code.length > 8 * 1024 * 1024) {
    throw new InvalidDeployment("Invalid source or compiled code");
  }
  if (typeof revision.created_at !== "string" || !Number.isFinite(Date.parse(revision.created_at))) throw new InvalidDeployment("Invalid revision timestamp");
  let manifest;
  try { manifest = parseManifest(revision.manifest); }
  catch { throw new InvalidDeployment("Invalid app manifest"); }
  const resources: ResourceLedger = Object.create(null);
  const ids = new Set<string>();
  for (const [name, raw] of Object.entries(object(input.resources, "resource ledger"))) {
    const resource = object(raw, "resource");
    if (!NAME.test(name) || ["__proto__", "constructor", "prototype"].includes(name)
      || typeof resource.type !== "string" || !RESOURCE_TYPES.has(resource.type)
      || typeof resource.id !== "string" || !HASH.test(resource.id) || ids.has(resource.id)) {
      throw new InvalidDeployment("Invalid resource identity");
    }
    ids.add(resource.id);
    resources[name] = { type: resource.type as ResourceLedger[string]["type"], id: resource.id };
  }
  for (const binding of Object.values(manifest.bindings)) {
    if (resources[binding.resource]?.type !== binding.type) throw new InvalidDeployment("Binding is missing its resource identity");
  }
  const secrets: Record<string, string> = Object.create(null);
  for (const [name, secret] of Object.entries(object(input.secrets, "secrets"))) {
    if (!manifest.secrets.includes(name) || typeof secret !== "string" || secret.length > 64 * 1024) throw new InvalidDeployment("Invalid app secret");
    secrets[name] = secret;
  }
  if (manifest.secrets.some(name => !(name in secrets))) throw new InvalidDeployment("Missing declared secret");
  return {
    app: input.app,
    revision: { id: revision.id, source: revision.source, code: revision.code, created_at: revision.created_at, manifest },
    resources,
    secrets,
  };
}

/** Only app bindings enter celld; no controller environment or provider credentials. */
export function celldConfig(deployment: Omit<NativeDeployment, "secrets">) {
  const { manifest } = deployment.revision;
  const ledger = deployment.resources;
  const bindings = Object.entries(manifest.bindings);
  return {
    name: workerName(deployment.app), main: "worker.js",
    compatibility_date: manifest.compatibility_date, compatibility_flags: manifest.compatibility_flags,
    vars: manifest.vars,
    durable_objects: { bindings: bindings.filter(([, b]) => b.type === "durable-object").map(([name, b]) => ({ name, class_name: classAlias(ledger[b.resource]!.id) })) },
    migrations: [{ tag: "retained-resources", new_sqlite_classes: Object.values(ledger).filter(r => r.type === "durable-object").map(r => classAlias(r.id)).sort() }],
    kv_namespaces: bindings.filter(([, b]) => b.type === "kv").map(([binding, b]) => ({ binding, id: ledger[b.resource]!.id })),
    r2_buckets: bindings.filter(([, b]) => b.type === "r2").map(([binding, b]) => ({ binding, bucket_name: resourceName(ledger[b.resource]!.id) })),
    d1_databases: bindings.filter(([, b]) => b.type === "d1").map(([binding, b]) => ({ binding, database_name: resourceName(ledger[b.resource]!.id), database_id: ledger[b.resource]!.id })),
    queues: {
      producers: bindings.filter(([, b]) => b.type === "queue").map(([binding, b]) => ({ binding, queue: resourceName(ledger[b.resource]!.id) })),
      consumers: manifest.triggers.queues.map(resource => ({ queue: resourceName(ledger[resource]!.id), max_batch_timeout: 0 })),
    },
    triggers: { crons: manifest.triggers.crons },
  };
}

async function atomicWrite(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function processCommand(pid: number): Promise<string> {
  const child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim();
}

/** One operator owns a data root; one serialized lifecycle owns each app. */
export class CelldOperator {
  private readonly root: string;
  private readonly tokenHash: Buffer;
  private binary = "";
  private esbuild = "";
  private closed = false;
  private rootLock?: Database;
  private runtimes = new Map<string, Runtime>();
  private mutations = new Map<string, Promise<unknown>>();
  private restartCounts = new Map<string, number>();
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: Options) {
    if (options.token.length < 32) throw new Error("Operator token must contain at least 32 characters");
    this.root = resolve(options.root);
    this.tokenHash = createHash("sha256").update(options.token).digest();
  }

  private directory(app: string) { return join(this.root, "apps", app); }
  private async journal(app: string) {
    return await readJson<Journal>(join(this.directory(app), "deployment.json")) ?? { resources: {} };
  }
  private async save(app: string, journal: Journal) {
    await atomicWrite(join(this.directory(app), "deployment.json"), JSON.stringify(journal));
  }
  private serial<T>(app: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.mutations.get(app) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.mutations.set(app, next);
    void next.finally(() => { if (this.mutations.get(app) === next) this.mutations.delete(app); }).catch(() => {});
    return next;
  }

  async start() {
    if (this.rootLock || this.closed) throw new Error("Operator has already started or stopped");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    // Hold an OS-backed SQLite lock for the operator lifetime. There is no
    // owner-file publication interval, stale-PID reclamation, or unlink race.
    // Never delete this file: contenders must always lock the same inode.
    const lockPath = join(this.root, "operator-lock.sqlite");
    const lock = new Database(lockPath);
    try { lock.exec("pragma busy_timeout = 0; begin exclusive"); }
    catch (error) {
      lock.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("Operator data root is locked");
      throw error;
    }
    this.rootLock = lock;
    try {
      await chmod(lockPath, 0o600);
      this.binary = resolve(this.options.binary ?? await ensureCelldRuntime({ dataRoot: join(this.root, "runtime") }));
      if (this.options.esbuild) this.esbuild = resolve(this.options.esbuild);
      else {
        // The installed package launcher may use a Node shebang. Invoke it with
        // our existing Bun runtime so a hoisted install needs neither host PATH
        // inheritance nor a separately installed Node executable.
        const launcher = fileURLToPath(import.meta.resolve("esbuild/bin/esbuild"));
        const file = await open(launcher, "r");
        const prefix = Buffer.alloc(64);
        try { await file.read(prefix, 0, prefix.length, 0); } finally { await file.close(); }
        if (prefix.toString().startsWith("#!/usr/bin/env node")) {
          const command = [process.execPath, launcher].map(path => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
          this.esbuild = join(this.root, "runtime", "esbuild");
          await atomicWrite(this.esbuild, `#!/bin/sh\nexec ${command} "$@"\n`);
          await chmod(this.esbuild, 0o700);
        } else this.esbuild = launcher; // esbuild's postinstall can replace the launcher with its native binary.
      }
      if (this.options.binary) {
        const version = Bun.spawn([this.binary, "--version"], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
        const output = (await new Response(version.stdout).text()).trim();
        if (await version.exited !== 0 || !output.split(/\r?\n/).includes(`celld ${CELLD_VERSION}`)) throw new Error(`Operator requires celld ${CELLD_VERSION}`);
      }
      await mkdir(join(this.root, "apps"), { recursive: true, mode: 0o700 });
      for (const app of await readdir(join(this.root, "apps"))) {
        if (!UUID.test(app)) continue;
        // A broken app must not prevent other apps or the repair API starting.
        try { await this.serial(app, () => this.reconcile(app)); }
        catch { console.error(`Native app ${app} requires deployment reconciliation`); }
      }
    } catch (error) { await this.close(); throw error; }
  }

  serve(options: { hostname?: string; port?: number } = {}) {
    if (!this.rootLock || this.server) throw new Error("Start the operator once before serving");
    this.server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1", port: options.port ?? 4792,
      maxRequestBodySize: MAX_REQUEST_BYTES,
      fetch: request => this.fetch(request),
    });
    return this.server;
  }

  async fetch(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const authorized = timingSafeEqual(this.tokenHash, createHash("sha256").update(supplied).digest());
    if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (this.closed) return Response.json({ error: "Operator is stopping" }, { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname === "/deploy" && request.method === "POST") {
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return Response.json({ error: "Deployment too large" }, { status: 413 });
        let input: unknown;
        try { input = JSON.parse(text); } catch { throw new InvalidDeployment("Invalid JSON"); }
        return Response.json(await this.deploy(validateDeployment(input), url.origin));
      } catch (error) {
        // Runtime logs and platform errors can include authored secrets; do not return them.
        return Response.json({ error: error instanceof InvalidDeployment ? error.message : "Deployment failed; reconciliation is required" }, { status: error instanceof InvalidDeployment ? 400 : 503 });
      }
    }
    const match = /^\/apps\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !UUID.test(match[1]!)) return Response.json({ error: "Not found" }, { status: 404 });
    if (request.headers.get("upgrade")) return Response.json({ error: "WebSocket proxying is not supported by this operator" }, { status: 501 });
    const runtime = this.runtimes.get(match[1]!);
    if (!runtime || runtime.stopping || runtime.child.exitCode !== null) return Response.json({ error: "App unavailable" }, { status: 503 });
    let target: URL;
    try {
      target = new URL(request.headers.get("x-artifacts-target-url") ?? `${url.origin}${match[2] ?? "/"}${url.search}`);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw new Error("Invalid target");
    } catch { return Response.json({ error: "Invalid app target URL" }, { status: 400 }); }
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "cookie", "host", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for",
      "x-artifacts-app-selection", "x-artifacts-gateway-token", "x-artifacts-target-url", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) headers.delete(name);
    headers.set("x-artifacts-target-url", target.href);
    try {
      return await fetch(`http://127.0.0.1:${runtime.record.port}${match[2] ?? "/"}${url.search}`, {
        method: request.method, headers, body: request.body, redirect: "manual", signal: request.signal,
      });
    } catch { return Response.json({ error: "App unavailable" }, { status: 503 }); }
  }

  async deploy(input: NativeDeployment, origin: string): Promise<ProviderResult> {
    const deployment = validateDeployment(input);
    return this.serial(deployment.app, async () => {
      if (this.closed) throw new Error("Operator is stopping");
      const journal = await this.journal(deployment.app);
      for (const [name, resource] of Object.entries(journal.resources)) {
        const next = deployment.resources[name];
        if (!next || next.id !== resource.id || next.type !== resource.type) throw new InvalidDeployment("Retained resource identities cannot change");
      }
      const revisionPath = join(this.directory(deployment.app), "revisions", `${deployment.revision.id}.json`);
      const savedRevision = await readJson<NativeDeployment["revision"]>(revisionPath);
      if (savedRevision && (savedRevision.source !== deployment.revision.source || savedRevision.code !== deployment.revision.code
        || JSON.stringify(savedRevision.manifest) !== JSON.stringify(deployment.revision.manifest))) throw new InvalidDeployment("Revision ID is immutable");
      await atomicWrite(revisionPath, JSON.stringify(deployment.revision));
      const secretFile = `${randomUUID()}.json`;
      await atomicWrite(join(this.directory(deployment.app), "secrets", secretFile), JSON.stringify(deployment.secrets));
      const { secrets: _, ...saved } = deployment;
      journal.desired = { ...saved, secretFile };
      journal.resources = deployment.resources;
      // Persist intent before replacing code, bindings, or the running process.
      await this.save(deployment.app, journal);
      const pendingRestart = this.restartTimers.get(deployment.app);
      if (pendingRestart) clearTimeout(pendingRestart);
      this.restartTimers.delete(deployment.app);
      this.restartCounts.delete(deployment.app);
      await this.activate(deployment.app, journal);
      return { revision: deployment.revision.id, endpoint: `${origin}/apps/${deployment.app}/` };
    });
  }

  private async reconcile(app: string) {
    await this.stopOrphan(app);
    const journal = await this.journal(app);
    if (journal.desired) await this.activate(app, journal);
    else if (journal.active) { await this.install(app, journal.active); await this.launch(app); }
    await this.cleanSecrets(app, await this.journal(app));
  }

  private async activate(app: string, journal: Journal) {
    const desired = journal.desired!;
    // Materialize the whole candidate before interrupting the previous deployment.
    const staged = await this.stage(app, desired);
    await this.stop(app);
    await this.stopOrphan(app);
    try {
      await this.install(app, desired, staged);
      await this.launch(app);
    } catch (error) {
      await this.stop(app);
      if (journal.active) {
        await this.install(app, journal.active);
        await this.launch(app);
      }
      // Desired remains durable, including when rollback failed; retry is explicit.
      throw error;
    }
    journal.active = desired;
    delete journal.desired;
    await this.save(app, journal);
    await this.cleanSecrets(app, journal);
  }

  private async stage(app: string, saved: SavedDeployment) {
    if (saved.app !== app || !UUID.test(saved.secretFile.replace(/\.json$/, ""))) throw new Error("Invalid deployment journal");
    const secrets = await readJson<Record<string, string>>(join(this.directory(app), "secrets", saved.secretFile));
    const deployment = validateDeployment({ ...saved, secrets });
    // celld reads .dev.vars with dotenv semantics. Use a private config containing
    // the app's variables to preserve arbitrary secret strings without interpolation.
    const config = { ...celldConfig(deployment), vars: { ...deployment.revision.manifest.vars, ...deployment.secrets } };
    const staging = join(this.directory(app), "staged");
    await atomicWrite(join(staging, "app.js"), deployment.revision.code);
    await atomicWrite(join(staging, "worker.js"), routingAdapter);
    await atomicWrite(join(staging, "wrangler.jsonc"), JSON.stringify(config));
    return staging;
  }

  private async install(app: string, saved: SavedDeployment, staged?: string) {
    const staging = staged ?? await this.stage(app, saved);
    const project = join(this.directory(app), "project");
    await mkdir(project, { recursive: true, mode: 0o700 });
    await rename(join(staging, "app.js"), join(project, "app.js"));
    await rename(join(staging, "worker.js"), join(project, "worker.js"));
    await rename(join(staging, "wrangler.jsonc"), join(project, "wrangler.jsonc"));
  }

  private scheduleRestart(app: string) {
    if (this.closed || this.restartTimers.has(app)) return;
    const attempts = (this.restartCounts.get(app) ?? 0) + 1;
    if (attempts > 3) return;
    this.restartCounts.set(app, attempts);
    const timer = setTimeout(() => {
      void this.serial(app, async () => {
        // A deployment can supersede even a timer already queued for this app.
        if (this.restartTimers.get(app) !== timer) return;
        this.restartTimers.delete(app);
        if (this.closed) return;
        const runtime = this.runtimes.get(app);
        if (runtime?.ready && !runtime.stopping && runtime.child.exitCode === null) return;
        try {
          const journal = await this.journal(app);
          if (!journal.active) return;
          await this.stop(app);
          await this.stopOrphan(app);
          await this.install(app, journal.active);
          await this.launch(app);
        } catch {
          console.error(`Native app ${app} could not restart`);
          this.scheduleRestart(app);
        }
      }).catch(() => console.error(`Native app ${app} restart scheduling failed`));
    }, attempts * 1000);
    this.restartTimers.set(app, timer);
  }

  private async launch(app: string) {
    if (this.closed) throw new Error("Operator is stopping");
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    const directory = this.directory(app);
    const command = [this.binary, "dev", join(directory, "project"), "--host", "127.0.0.1", "--port", String(port), "--no-watch"];
    // The child publishes its own PID before exec so a controller crash during
    // readiness does not strand an unrecorded celld supervisor.
    await atomicWrite(join(directory, "launch.json"), JSON.stringify({ command, port }));
    const child = Bun.spawn(["/bin/sh", "-c", 'umask 077; printf "%s" "$$" > "$1"; shift; exec "$@"', "native-worker", join(directory, "runtime.pid"), ...command], {
      cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: directory, TMPDIR: directory, CELLD_ESBUILD: this.esbuild, NO_COLOR: "1" },
    });
    const runtime: Runtime = { child, record: { pid: child.pid, command, port }, stopping: false, ready: false };
    this.runtimes.set(app, runtime);
    // Consume pipes without persisting application output or secrets in logs.
    for (const stream of [child.stdout, child.stderr]) if (stream && typeof stream !== "number") {
      void (async () => { for await (const _ of stream) {} })().catch(() => {});
    }
    void child.exited.then(() => {
      if (!runtime.ready || runtime.stopping || this.closed || this.runtimes.get(app) !== runtime) return;
      this.runtimes.delete(app);
      this.scheduleRestart(app);
    });
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 45_000);
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/celld/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json() as { ok?: boolean }).ok === true) { runtime.ready = true; return; }
      } catch {}
      await Bun.sleep(100);
    }
    await this.stop(app);
    throw new Error("celld runtime did not become ready");
  }

  private async stop(app: string) {
    const runtime = this.runtimes.get(app);
    if (!runtime) return;
    runtime.stopping = true;
    if (runtime.child.exitCode === null) {
      runtime.child.kill("SIGTERM");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        runtime.child.exited.then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 40_000); }),
      ]).finally(() => clearTimeout(timeout));
      if (!stopped) throw new Error("celld did not stop; refusing another writer on retained state");
    }
    this.runtimes.delete(app);
    await rm(join(this.directory(app), "runtime.pid"), { force: true });
  }

  private async stopOrphan(app: string) {
    if (this.runtimes.has(app)) return;
    const directory = this.directory(app);
    const launch = await readJson<Omit<RuntimeRecord, "pid">>(join(directory, "launch.json"));
    let pid: number;
    try { pid = Number(await readFile(join(directory, "runtime.pid"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!Number.isSafeInteger(pid) || pid <= 0 || !launch) throw new Error("Invalid persisted runtime identity");
    if (alive(pid)) {
      // Never signal a reused PID or a process outside this app's exact launch.
      if (await processCommand(pid) !== launch.command.join(" ")) throw new Error("Runtime PID no longer identifies this app; refusing to signal it");
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 40_000;
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(100);
      if (alive(pid)) throw new Error("Previous runtime has not stopped");
    }
    // A forcibly killed dev supervisor can leave its node alive on some hosts.
    // Do not start a second writer merely because the supervisor PID is gone.
    let oldListener = false;
    try {
      const response = await fetch(`http://127.0.0.1:${launch.port}/.well-known/celld/health`, { signal: AbortSignal.timeout(1000) });
      oldListener = response.ok;
      await response.body?.cancel();
    } catch {}
    if (oldListener) throw new Error("Previous runtime listener remains active; refusing another writer");
    await rm(join(directory, "runtime.pid"), { force: true });
  }

  private async cleanSecrets(app: string, journal: Journal) {
    const directory = join(this.directory(app), "secrets");
    const keep = new Set([journal.active?.secretFile, journal.desired?.secretFile]);
    for (const name of await readdir(directory)) if (!keep.has(name)) await rm(join(directory, name));
  }

  async close() {
    this.closed = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    this.server?.stop(true);
    await Promise.allSettled(this.mutations.values());
    await Promise.all([...this.runtimes.keys()].map(app => this.stop(app)));
    if (this.rootLock) {
      this.rootLock.close();
      this.rootLock = undefined;
    }
  }
}

if (import.meta.main) {
  const token = process.env.NATIVE_WORKER_OPERATOR_TOKEN;
  if (!token) throw new Error("NATIVE_WORKER_OPERATOR_TOKEN is required");
  const operator = new CelldOperator({
    root: process.env.NATIVE_WORKER_OPERATOR_ROOT ?? join(artifactDataRoot(), "native-workers"), token,
    binary: process.env.CELLD_BIN, esbuild: process.env.CELLD_ESBUILD,
  });
  await operator.start();
  const server = operator.serve({ hostname: process.env.NATIVE_WORKER_OPERATOR_HOST ?? "127.0.0.1", port: Number(process.env.NATIVE_WORKER_OPERATOR_PORT ?? 4792) });
  console.error(`Native Worker operator listening on ${server.url.origin}`);
  const shutdown = () => { void operator.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
