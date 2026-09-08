import { readFile, writeFile, rename } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { startTailnetGateway, type TailnetGatewayConfig } from "./tailnet-gateway";

// Deployment paths are explicit. Restarting never rebuilds or replaces assets.
export type HostConfig = {
  runtimeConfig: string;
  celld: string;
  esbuild: string;
  githubCli?: string;
  runnerCanvas?: string;
  keepWarm?: boolean;
  warmGallery?: boolean;
  warmCanvases?: string[];
  gateway: TailnetGatewayConfig;
};
/** Leave timed eviction unset for a warm host; pressure/cap eviction still applies. */
export function hostRuntimeEnvironment(config: Pick<HostConfig, "esbuild" | "keepWarm">, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: env.PATH, HOME: env.HOME, CELLD_ESBUILD: config.esbuild, CELLD_WORKER_LOADER: "LOADER", ...(config.keepWarm ? {} : { CELLD_IDLE_EVICT_S: "60" }), RUST_LOG: "warn" };
}
export function validateWarmCanvases(names: string[] = []): string[] {
  if (!Array.isArray(names) || names.length > 20 || names.some(name => typeof name !== "string" || !name || name.includes("\0") || Buffer.byteLength(name, "utf8") > 4096)) throw new Error("--warm-canvases accepts up to 20 nonempty canvas names, each at most 4096 bytes and without NUL");
  return [...new Set(names)];
}

/** Warm only management reads, never arbitrary artifact routes or script backends. */
export function startHostWarmer(config: Pick<HostConfig, "gateway" | "warmGallery" | "warmCanvases">, options: {
  intervalMs?: number; timeoutMs?: number; warn?: (message: string) => void;
} = {}) {
  const paths = [
    ...(config.warmGallery ? ["/api/gallery"] : []),
    ...validateWarmCanvases(config.warmCanvases).map(name => `/gallery/preview?${new URLSearchParams({ name })}`),
  ];
  const controller = new AbortController(), failures = new Map<string, string>();
  const warn = options.warn ?? console.warn;
  const done = (async () => {
    if (!paths.length) return;
    while (!controller.signal.aborted) {
      for (const path of paths) {
        if (controller.signal.aborted) break;
        let failure: string | undefined;
        try {
          const response = await fetch(new URL(path, config.gateway.upstreamOrigin), {
            method: "GET", redirect: "manual",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 25_000)]),
          });
          await response.body?.cancel();
          if (!response.ok) failure = `HTTP ${response.status}`;
        } catch { if (!controller.signal.aborted) failure = "request failed or timed out"; }
        if (failure) {
          if (failures.get(path) !== failure) warn(`Canvas targeted warm-up: ${failure}`);
          failures.set(path, failure);
        } else failures.delete(path);
      }
      if (!controller.signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, options.intervalMs ?? 30_000);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    }
  })();
  return { done, stop: async () => { controller.abort(); await done; } };
}

export async function seedRunner(origin: string, sourcePath: string) {
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${origin}/api/tools`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as { isError?: boolean; structuredContent?: { ok?: boolean } };
    if (!response.ok || result.isError || result.structuredContent?.ok === false) throw new Error(`${name} failed; inspect the Canvas gallery`);
  }
  // Preserve edits and revision history when restarting an existing example.
  const source = await fetch(`${origin}/api/source?name=runner-status`);
  await source.body?.cancel();
  if (source.status === 404) {
    await call("artifact_guide", {});
    await call("artifact_write", { name: "runner-status", contents: await Bun.file(sourcePath).text() });
  } else if (!source.ok) throw new Error("Unable to inspect existing canvas");
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await fetch(`${origin}/api/gallery?offset=${offset}`);
    if (!response.ok) throw new Error("Unable to inspect existing canvas link");
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

export async function runHost(config: HostConfig) {
  const upstream = new URL(config.gateway.upstreamOrigin);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port) throw new Error("Host upstream must be an explicit loopback HTTP port");
  const directory = dirname(config.runtimeConfig);
  const lock = new Database(join(directory, "host-lock.sqlite"), { create: true });
  try { lock.exec("begin exclusive"); }
  catch { lock.close(); throw new Error("Canvas host already owns this state directory"); }
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let gateway: ReturnType<typeof startTailnetGateway> | undefined;
  let warmer: ReturnType<typeof startHostWarmer> | undefined;
  let stopping = false;
  let killTimeout: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopping = true;
    void warmer?.stop();
    gateway?.stop(true);
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      killTimeout ??= setTimeout(() => { if (child?.exitCode === null) child.kill("SIGKILL"); }, 45_000);
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const runtime = JSON.parse(await readFile(config.runtimeConfig, "utf8"));
    runtime.vars = { ...runtime.vars, CANVAS_PUBLIC_ORIGIN: config.gateway.publicOrigin };
    if (config.githubCli) {
      const auth = Bun.spawn([config.githubCli, "auth", "token", "--hostname", "github.com"], { stdout: "pipe", stderr: "ignore" });
      const token = (await new Response(auth.stdout).text()).trim();
      if (await auth.exited !== 0 || !token) throw new Error("GitHub authentication unavailable; use gh auth login on this host");
      runtime.vars.GITHUB_TOKEN = token;
      runtime.vars.RUNNER_STATUS_TOKEN ||= randomBytes(32).toString("hex");
    }
    const temporary = `${config.runtimeConfig}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(runtime, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, config.runtimeConfig);
    if (stopping) return;
    child = Bun.spawn([config.celld, "dev", config.runtimeConfig, "--host", "127.0.0.1", "--port", upstream.port, "--no-watch", "--logs"], {
      cwd: directory, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: hostRuntimeEnvironment(config),
    });
    // Busy build hosts can take several minutes to bundle and start workerd.
    const deadline = Date.now() + 300_000;
    let ready = false;
    while (!stopping && child.exitCode === null && Date.now() < deadline) {
      try {
        const response = await fetch(`${upstream.origin}/health`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(150);
    }
    if (!ready) throw new Error("Canvas runtime did not become ready");
    if (config.runnerCanvas) await seedRunner(upstream.origin, config.runnerCanvas);
    gateway = startTailnetGateway(config.gateway);
    warmer = startHostWarmer(config);
    console.log(`Canvas host ready: ${config.gateway.publicOrigin} (celld ${upstream.origin})`);
    const code = await child.exited;
    if (!stopping) throw new Error(`Canvas runtime exited (${code})`);
  } finally {
    stop();
    if (child?.exitCode === null) {
      await child.exited;
    }
    await warmer?.stop();
    clearTimeout(killTimeout);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    lock.close();
  }
}
if (import.meta.main) {
  try { await runHost(await Bun.file(process.argv[2]!).json()); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
