import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { appScope, nativeConfig, parseManifest, planResources, type AppManifest, type ResourceLedger } from "./manifest";

type Revision = { manifest: AppManifest; code: string };
type State = { active: string; resources: ResourceLedger; revisions: Record<string, Revision> };

/** Development proof of an app deployment provider, separate from artifact/script execution. */
export class NativeWorkerHost {
  readonly scope: string;
  private readonly directory: string;
  private runtime?: Miniflare;
  private state?: State;
  private options?: MiniflareOptions;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(root: string, owner: string, app: string) {
    this.scope = appScope(owner, app);
    this.directory = join(resolve(root), this.scope);
  }

  private async loadState() {
    if (this.state) return this.state;
    try { this.state = JSON.parse(await readFile(join(this.directory, "deployment.json"), "utf8")) as State; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { active: "", resources: {}, revisions: {} };
    }
    return this.state;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => {});
    return result;
  }

  deploy(manifest: unknown, code: string, secrets: Record<string, string> = {}) {
    const input = { manifest: parseManifest(manifest), code };
    const suppliedSecrets = structuredClone(secrets);
    return this.serial(() => this.activate(input, suppliedSecrets));
  }

  restore(revision: string, secrets: Record<string, string> = {}) {
    const suppliedSecrets = structuredClone(secrets);
    return this.serial(async () => {
      const saved = (await this.loadState()).revisions[revision];
      if (!saved) throw new Error("Unknown revision");
      return this.activate(saved, suppliedSecrets);
    });
  }

  private async activate(input: Revision, secrets: Record<string, string>) {
    const previous = await this.loadState();
    const resources = planResources(this.scope, input.manifest, previous.resources);
    const options: MiniflareOptions = {
      cf: false, host: "127.0.0.1", port: 0, resourcePersistencePath: join(this.directory, "storage"),
      workers: [nativeConfig(this.scope, input.manifest, input.code, resources, secrets)],
    };
    try {
      if (this.runtime) await this.runtime.setOptions(options);
      else { this.runtime = new Miniflare(options); await this.runtime.ready; }
    } catch (error) {
      // Reinstall the known configuration after a rejected module/config update.
      if (this.options) await this.runtime!.setOptions(this.options);
      else { await this.runtime?.dispose(); this.runtime = undefined; }
      throw error;
    }
    const revision = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const state: State = { active: revision, resources, revisions: { ...previous.revisions, [revision]: input } };
    try {
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      await Bun.write(temporary, JSON.stringify(state, null, 2));
      await rename(temporary, join(this.directory, "deployment.json"));
    } catch (error) {
      if (this.options) await this.runtime!.setOptions(this.options);
      else { await this.runtime?.dispose(); this.runtime = undefined; }
      throw error;
    }
    this.options = options;
    this.state = state;
    return { revision, resources: structuredClone(resources), url: (await this.runtime!.ready).href };
  }

  async fetch(path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) {
    if (!this.runtime) throw new Error("Deploy or restore the app first");
    return this.runtime.dispatchFetch(new URL(path, "https://app.invalid"), init);
  }

  async scheduled(cron: string, time = Date.now()) {
    const state = await this.loadState();
    if (!this.runtime || !state.revisions[state.active]?.manifest.triggers.crons.includes(cron)) throw new Error("Undeclared cron trigger");
    const worker = await this.runtime.getWorker(`app-${this.scope}`);
    return worker.scheduled({ cron, scheduledTime: new Date(time) });
  }

  async send(resource: string, body: unknown) {
    const state = await this.loadState();
    const binding = Object.entries(state.revisions[state.active]?.manifest.bindings ?? {}).find(([, binding]) => binding.type === "queue" && binding.resource === resource);
    if (!this.runtime || !binding) throw new Error("Undeclared queue");
    const producer = await this.runtime.getQueueProducer(binding[0], `app-${this.scope}`);
    await producer.send(body);
  }

  async dispose() { await this.mutation; await this.runtime?.dispose(); this.runtime = undefined; }
}

/** Bundle with ordinary Workers imports/exports; no artifact export normalization or wrapper. */
export async function loadProject(manifestPath: string) {
  const manifest = parseManifest(Bun.JSONC.parse(await Bun.file(manifestPath).text()));
  const root = await realpath(dirname(resolve(manifestPath)));
  const entrypoint = await realpath(resolve(root, manifest.main));
  const location = relative(root, entrypoint);
  if (location.startsWith("../") || location === "..") throw new Error("main resolves outside the project");
  const build = await Bun.build({ entrypoints: [entrypoint], target: "browser", format: "esm", external: ["cloudflare:workers", "node:*"], minify: false });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return { manifest, code: await build.outputs[0]!.text() };
}

if (import.meta.main) {
  const [manifestPath, owner = "local", app = "example"] = process.argv.slice(2);
  if (!manifestPath) throw new Error("Usage: bun run scripts/native-worker/host.ts <app.json> [physical-owner] [app]");
  const { manifest, code } = await loadProject(manifestPath);
  // Only explicitly declared app secrets enter the Worker environment.
  const secrets: Record<string, string> = {};
  for (const name of manifest.secrets) {
    const value = process.env[`NATIVE_WORKER_SECRET_${name}`];
    if (value === undefined) throw new Error(`Set NATIVE_WORKER_SECRET_${name}`);
    secrets[name] = value;
  }
  const host = new NativeWorkerHost(resolve(".artifacts/native-workers"), owner, app);
  const deployed = await host.deploy(manifest, code, secrets);
  console.log(`Native Worker: ${deployed.url}\nRevision: ${deployed.revision}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void host.dispose().then(() => process.exit(0)));
  // Miniflare runs in a child process; keep this development controller alive.
  await new Promise(() => {});
}
