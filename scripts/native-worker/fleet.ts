import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolve4 } from "node:dns/promises";
import { S3Client } from "@aws-sdk/client-s3";
import {
  CELLD_VERSION,
  ensureCelldRuntime,
} from "../../src/local/celld-runtime";
import { celldConfig, validateDeployment } from "./operator";
import { FleetStore } from "./fleet-store";
import {
  FLEET_REGISTRY_VAR,
  FLEET_PUBLICATION_VAR,
  FLEET_SCHEDULER_EXPORT,
  fleetBinding,
  fleetScheduleBinding,
  readFleetRegistry,
  type FleetApp,
  type FleetPointer,
  type FleetRegistry,
} from "../../cloudflare/native-worker/fleet-contract";
import {
  resourceName,
  workerName,
  type NativeDeployment,
  type ProviderResult,
} from "../../cloudflare/native-worker/types";

type Manifest = {
  script_name: string;
  version: string;
  raw_metadata: { bindings: { name: string; type: string; text?: string }[] };
};
type HostConfig = {
  name: string;
  main: string;
  assets?: { directory: string };
  vars?: Record<string, string>;
  services?: { binding: string; service: string; entrypoint?: string }[];
  triggers?: { crons?: string[] };
  [key: string]: unknown;
};
export type FleetOperatorOptions = {
  bucket: string;
  config: string;
  token: string;
  binary?: string;
  esbuild?: string;
  endpoint?: string;
  region?: string;
  client?: S3Client;
  nodes?: string[];
  nodeService?: { hostname: string; port: number };
  basePath?: string;
  readinessTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
};

// The fleet fires the primary script's crons. Invoke each app's native handler
// through a generated WorkerEntrypoint in that app's own isolate and env.
export const fleetAppWrapper = `import app from "./app.js";
import { WorkerEntrypoint } from "cloudflare:workers";
export * from "./app.js";
export default app;
export class ${FLEET_SCHEDULER_EXPORT} extends WorkerEntrypoint {
  async runScheduled(event) {
    let noRetry = false;
    const pending = [];
    const context = new Proxy(this.ctx, { get(target, key) {
      if (key === "waitUntil") return promise => { const task = Promise.resolve(promise); pending.push(task); target.waitUntil(task); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const controller = { ...event, noRetry() { noRetry = true; } };
    const handler = typeof app === "function" ? new app(context, this.env) : app;
    try {
      if (typeof handler.scheduled !== "function") throw new Error("Missing scheduled handler");
      await handler.scheduled(controller, this.env, context);
      await Promise.all(pending);
      return { outcome: "ok", noRetry };
    } catch { return { outcome: "failed", noRetry }; }
  }
}
`;

export function fleetHostConfig(
  config: HostConfig,
  registry: FleetRegistry,
  publication: string,
): HostConfig {
  readFleetRegistry(registry);
  const services = config.services ?? [];
  if (services.some((binding) => binding.binding.startsWith("ARTIFACTS_APP_")))
    throw new Error(
      "Native fleet service binding conflicts with host configuration",
    );
  return {
    ...config,
    vars: {
      ...config.vars,
      [FLEET_REGISTRY_VAR]: JSON.stringify(registry),
      [FLEET_PUBLICATION_VAR]: publication,
    },
    services: [
      ...services,
      ...registry.apps.flatMap((app) => [
        { binding: fleetBinding(app.app), service: app.pointer.script_name },
        {
          binding: fleetScheduleBinding(app.app),
          service: app.pointer.script_name,
          entrypoint: FLEET_SCHEDULER_EXPORT,
        },
      ]),
    ],
    triggers: {
      ...config.triggers,
      crons: [
        ...new Set([
          ...(config.triggers?.crons ?? []),
          ...registry.apps.flatMap((app) => app.crons),
        ]),
      ],
    },
  };
}

/** A single publisher owns native components and the primary Artifacts graph. */
export class CelldFleetOperator {
  private readonly store: FleetStore;
  private readonly tokenHash: Buffer;
  private readonly basePath: string;
  private binary = "";
  private esbuild = "";
  private host!: HostConfig;
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private server?: ReturnType<typeof Bun.serve>;
  constructor(private readonly options: FleetOperatorOptions) {
    if (options.token.length < 32)
      throw new Error("Operator token must contain at least 32 characters");
    this.tokenHash = createHash("sha256").update(options.token).digest();
    this.basePath = options.basePath?.replace(/\/$/, "") ?? "";
    if (this.basePath && !/^\/[a-z0-9/-]+$/.test(this.basePath))
      throw new Error("Invalid operator base path");
    this.store = new FleetStore(
      options.client ??
        new S3Client({
          region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
          endpoint: options.endpoint,
          forcePathStyle: !!options.endpoint,
        }),
      options.bucket,
    );
  }
  async start() {
    const configPath = resolve(this.options.config);
    this.host = Bun.JSONC.parse(
      await readFile(configPath, "utf8"),
    ) as HostConfig;
    if (!this.host.name || !this.host.main)
      throw new Error("Fleet operator requires the host Worker configuration");
    this.host.main = resolve(dirname(configPath), this.host.main);
    if (this.host.assets)
      this.host.assets.directory = resolve(
        dirname(configPath),
        this.host.assets.directory,
      );
    this.binary =
      this.options.binary ??
      (await ensureCelldRuntime({
        dataRoot: join(tmpdir(), "artifacts-fleet-runtime"),
      }));
    const version = Bun.spawn([this.binary, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (
      !(await new Response(version.stdout).text())
        .split(/\r?\n/)
        .includes(`celld ${CELLD_VERSION}`) ||
      (await version.exited) !== 0
    )
      throw new Error(`Fleet operator requires celld ${CELLD_VERSION}`);
    this.esbuild =
      this.options.esbuild ??
      Bun.resolveSync(
        `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
        dirname(Bun.resolveSync("esbuild/package.json", import.meta.dir)),
      );
  }
  serve(options: { hostname?: string; port?: number } = {}) {
    if (!this.binary || this.server)
      throw new Error("Start the fleet operator once before serving");
    this.server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 4792,
      maxRequestBodySize: 16 * 1024 * 1024,
      // Publication waits for node adoption (up to 90s) after compiling apps.
      idleTimeout: 255,
      fetch: (request) => this.fetch(request),
    });
    return this.server;
  }
  async fetch(request: Request): Promise<Response> {
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (
      !timingSafeEqual(
        this.tokenHash,
        createHash("sha256").update(supplied).digest(),
      )
    )
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (this.stopped)
      return Response.json({ error: "Operator is stopping" }, { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === `${this.basePath}/health` && request.method === "GET")
      return Response.json({ ok: true });
    try {
      if (
        url.pathname === `${this.basePath}/deploy` &&
        request.method === "POST"
      ) {
        const input = validateDeployment(await request.json());
        return Response.json(await this.deploy(input));
      }
      if (
        url.pathname === `${this.basePath}/host` &&
        request.method === "POST"
      ) {
        // The release hook runs before the nodes on a fresh fleet.
        return Response.json(await this.publishHost(false));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch {
      // Configuration, compiled modules and platform errors can contain secrets.
      return Response.json(
        { error: "Fleet publication failed; reconciliation is required" },
        { status: 503 },
      );
    }
  }
  private serial<T>(operation: () => Promise<T>) {
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result;
    return result;
  }
  private async current() {
    const pointer = await this.store.json<FleetPointer>("deploy/current.json");
    if (!pointer) return { etag: null, registry: readFleetRegistry(undefined) };
    if (pointer.value.script_name !== this.host.name)
      throw new Error(
        "Fleet default Worker differs from the configured Artifacts host",
      );
    const manifest = await this.store.json<Manifest>(
      `${pointer.value.prefix}/manifest.json`,
    );
    if (
      !manifest ||
      manifest.value.script_name !== this.host.name ||
      manifest.value.version !== pointer.value.version
    )
      throw new Error("Invalid fleet host deployment");
    const binding = manifest.value.raw_metadata.bindings.find(
      (binding) => binding.name === FLEET_REGISTRY_VAR,
    );
    return { etag: pointer.etag, registry: readFleetRegistry(binding?.text) };
  }
  private async stage(
    directory: string,
  ): Promise<{ prefix: string; pointer: FleetPointer }> {
    const prefix = `.artifacts-native-staging/${randomUUID()}`;
    const command = [
      this.binary,
      "deploy",
      directory,
      "--bucket",
      `${this.options.bucket.replace(/\/$/, "")}/${prefix}`,
      "--json",
      ...(this.options.endpoint ? ["--endpoint", this.options.endpoint] : []),
      ...(this.options.region ? ["--region", this.options.region] : []),
    ];
    const process = Bun.spawn(command, {
      env: {
        ...globalThis.process.env,
        ...this.options.environment,
        CELLD_ESBUILD: this.esbuild,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain build output without logging configuration or authored values.
    const [, diagnostic] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
    ]);
    if ((await process.exited) !== 0)
      throw new Error("celld candidate deployment failed", {
        cause: diagnostic,
      });
    const pointer = await this.store.json<FleetPointer>(
      `${prefix}/deploy/current.json`,
    );
    if (!pointer) throw new Error("celld candidate pointer is missing");
    const keys = await this.store.keys(`${prefix}/deploy/`);
    for (const key of keys) {
      const target = key.slice(prefix.length + 1);
      if (
        target.endsWith("/current.json") ||
        target.startsWith("deploy/queues/")
      )
        continue;
      await this.store.copyImmutable(key, target);
    }
    return { prefix, pointer: pointer.value };
  }
  private async candidateHost(
    registry: FleetRegistry,
    publication: string,
    directory: string,
  ) {
    const config = fleetHostConfig(this.host, registry, publication);
    await cp(dirname(this.host.main), join(directory, "host-code"), {
      recursive: true,
    });
    if (config.assets) {
      await cp(config.assets.directory, join(directory, "assets"), {
        recursive: true,
      });
      config.assets = { ...config.assets, directory: "assets" };
    }
    const module = `./host-code/${basename(this.host.main)}`;
    const entry = `import host from ${JSON.stringify(module)};
export * from ${JSON.stringify(module)};
export default {
  fetch(request, env, ctx) { return host.fetch(request, env, ctx); },
  async scheduled(controller, env, ctx) {
    ${this.host.triggers?.crons?.length ? `if (${JSON.stringify(this.host.triggers.crons)}.includes(controller.cron) && host.scheduled) await host.scheduled(controller, env, ctx);` : ""}
    const result = await env.NATIVE_APPS.getByName("deployment").fireCron({ cron: controller.cron, scheduledTime: controller.scheduledTime });
    if (result.failed) throw new Error("Worker app cron handler failed");
  }
};`;
    await writeFile(join(directory, "host.ts"), entry, { mode: 0o600 });
    await writeFile(
      join(directory, "wrangler.jsonc"),
      JSON.stringify({ ...config, main: "host.ts", no_bundle: false }),
      { mode: 0o600 },
    );
    return this.stage(directory);
  }
  private async ready(publication: string) {
    if (!this.options.nodes?.length && !this.options.nodeService) return;
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      const discovery = this.options.nodeService;
      const nodes = discovery
        ? (await resolve4(discovery.hostname)).map(
            (address) => `http://${address}:${discovery.port}`,
          )
        : this.options.nodes!;
      const results = await Promise.all(
        nodes.map(async (node) => {
          try {
            const response = await fetch(
              new URL("/api/native-fleet/ready", node),
              {
                headers: { Authorization: `Bearer ${this.options.token}` },
                signal: AbortSignal.timeout(2000),
              },
            );
            return (
              response.ok &&
              ((await response.json()) as { publication?: string })
                .publication === publication
            );
          } catch {
            return false;
          }
        }),
      );
      if (results.length && results.every(Boolean)) return;
      await Bun.sleep(500);
    }
    throw new Error("Fleet nodes did not adopt the publication");
  }
  private async commit(
    registry: FleetRegistry,
    expected: string | null,
    directory: string,
    waitForNodes = true,
  ) {
    const publication = createHash("sha256")
      .update(JSON.stringify(registry))
      .update(JSON.stringify(this.host))
      .update(await readFile(this.host.main))
      .digest("hex");
    const candidate = await this.candidateHost(
      registry,
      publication,
      directory,
    );
    await this.store.put(
      `deploy/${this.host.name}/current.json`,
      candidate.pointer,
    );
    // Only this pointer selects the fleet's public application. Never point it
    // at an authored app, and reject an intervening host deployment.
    await this.store.put("deploy/current.json", candidate.pointer, expected);
    if (waitForNodes) await this.ready(publication);
    return publication;
  }
  async publishHost(waitForNodes = true) {
    return this.serial(async () => {
      const current = await this.current();
      const directory = await mkdtemp(join(tmpdir(), "artifacts-fleet-host-"));
      try {
        return {
          ok: true,
          publication: await this.commit(
            current.registry,
            current.etag,
            directory,
            waitForNodes,
          ),
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  async deploy(input: NativeDeployment): Promise<ProviderResult> {
    if (!this.options.nodes?.length && !this.options.nodeService)
      throw new Error("Configure fleet node discovery before deploying apps");
    const deployment = validateDeployment(input);
    return this.serial(async () => {
      const current = await this.current();
      const directory = await mkdtemp(join(tmpdir(), "artifacts-fleet-app-"));
      try {
        const appDirectory = join(directory, "app");
        const hostDirectory = join(directory, "host");
        await mkdir(appDirectory);
        await mkdir(hostDirectory);
        await writeFile(
          join(appDirectory, "app.js"),
          deployment.revision.code,
          { mode: 0o600 },
        );
        await writeFile(join(appDirectory, "worker.js"), fleetAppWrapper, {
          mode: 0o600,
        });
        const config = celldConfig(deployment);
        await writeFile(
          join(appDirectory, "wrangler.jsonc"),
          JSON.stringify({
            ...config,
            vars: { ...config.vars, ...deployment.secrets },
            triggers: { crons: [] },
          }),
          { mode: 0o600 },
        );
        const candidate = await this.stage(appDirectory);
        if (candidate.pointer.script_name !== workerName(deployment.app))
          throw new Error("Invalid native app candidate");
        const app: FleetApp = {
          app: deployment.app,
          revision: deployment.revision.id,
          pointer: candidate.pointer,
          crons: deployment.revision.manifest.triggers.crons,
          queues: Object.values(deployment.resources)
            .filter((resource) => resource.type === "queue")
            .map((resource) => resourceName(resource.id)),
        };
        const previous = current.registry.apps.find(
          (item) => item.app === app.app,
        );
        // Publish native queue attachments before their service pointers, in
        // the same order as celld deploy. Removed consumers retain tombstones.
        for (const queue of new Set([
          ...(previous?.queues ?? []),
          ...app.queues,
        ])) {
          const key = `deploy/queues/${queue}/consumer.json`;
          const attachment = await this.store.json<unknown>(
            `${candidate.prefix}/${key}`,
          );
          await this.store.put(
            key,
            attachment?.value ?? { schema_version: 1, queue, consumer: null },
          );
        }
        await this.store.put(
          `deploy/${app.pointer.script_name}/current.json`,
          app.pointer,
        );
        const registry: FleetRegistry = {
          schema_version: 1,
          apps: [
            ...current.registry.apps.filter((item) => item.app !== app.app),
            app,
          ].sort((a, b) => a.app.localeCompare(b.app)),
        };
        await this.commit(registry, current.etag, hostDirectory);
        return {
          revision: deployment.revision.id,
          endpoint: `https://native-app.internal/${deployment.app}/`,
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  async close() {
    this.stopped = true;
    await this.pending.catch(() => {});
    await this.server?.stop(true);
  }
}

if (import.meta.main) {
  const token = process.env.NATIVE_CELLD_FLEET_OPERATOR_TOKEN;
  if (!token) throw new Error("Set NATIVE_CELLD_FLEET_OPERATOR_TOKEN");
  if (process.argv.includes("--request-host")) {
    const endpoint = process.env.NATIVE_CELLD_FLEET_RELEASE_URL;
    if (!endpoint) throw new Error("Set NATIVE_CELLD_FLEET_RELEASE_URL");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(240_000),
      redirect: "manual",
    });
    if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
      throw new Error("Fleet host publication failed");
    process.exit(0);
  }
  const operator = new CelldFleetOperator({
    bucket: process.env.CELLD_BUCKET ?? "",
    config: process.env.NATIVE_CELLD_FLEET_CONFIG ?? "/app/wrangler.jsonc",
    token,
    binary: process.env.CELLD_BIN,
    esbuild: process.env.CELLD_ESBUILD,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.AWS_REGION,
    basePath: process.env.NATIVE_CELLD_FLEET_BASE_PATH,
    nodes: process.env.NATIVE_CELLD_FLEET_NODES?.split(",").filter(Boolean),
    ...(process.env.NATIVE_CELLD_FLEET_NODE_SERVICE
      ? {
          nodeService: {
            hostname: process.env.NATIVE_CELLD_FLEET_NODE_SERVICE,
            port: Number(process.env.NATIVE_CELLD_FLEET_NODE_PORT ?? 4786),
          },
        }
      : {}),
  });
  await operator.start();
  operator.serve({
    hostname: process.env.NATIVE_CELLD_FLEET_HOST ?? "127.0.0.1",
    port: Number(process.env.NATIVE_CELLD_FLEET_PORT ?? 4792),
  });
  const stop = async () => {
    await operator.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
