import { chmod, cp, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { flagBoolean, flagString, type ParsedArgs } from "../args";
import { PLUGIN_ROOT } from "../paths";
import { artifactDataRoot, ensureCelldRuntime } from "./celld-runtime";
import { createTailnetGatewayHandler } from "./tailnet-gateway";
import { runHost, validateWarmCanvases, type HostConfig } from "./host-service";
import { acquireHostBackupLock } from "./host-backup";
import type { RunCommand } from "./server-daemon";

const label = "com.sidequery.canvas-host";
export type HostInstallOptions = {
  origin: string; tailscaleLogin: string; runnerOrg?: string; runnerRepos?: string;
  githubCli?: string; serve?: boolean; replaceServe?: boolean; keepWarm?: boolean; warmGallery?: boolean; warmCanvases?: string[];
};
export type HostDependencies = {
  packageRoot?: string; dataRoot?: string; home?: string; platform?: string; uid?: number;
  celldPath?: string; esbuildPath?: string; serviceCommand?: string[];
  runCommand?: RunCommand; healthCheck?: (config: HostConfig) => Promise<boolean>;
  ensureRuntime?: () => Promise<string>; portAvailable?: (port: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>; now?: () => number;
};

async function runCommand(command: string, args: string[]) {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function hostPlist(command: string[], project: string, log: string, home: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${command.map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer><key>ExitTimeOut</key><integer>50</integer>
<key>EnvironmentVariables</key><dict>${process.env.BUN_BE_BUN === "1" ? "<key>BUN_BE_BUN</key><string>1</string>" : ""}<key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}

export function hostRuntime(template: Record<string, any>, options: HostInstallOptions) {
  createTailnetGatewayHandler({ publicOrigin: options.origin, allowedLogin: options.tailscaleLogin, upstreamOrigin: "http://127.0.0.1:4788", port: 4789 });
  if (new URL(options.origin).port) throw new Error("Canvas host uses HTTPS port 443");
  if (options.replaceServe && !options.serve) throw new Error("--replace-serve requires --serve");
  const runner = options.runnerOrg !== undefined || options.runnerRepos !== undefined;
  const repos = [...new Set(options.runnerRepos?.split(",").map(repo => repo.trim()).filter(Boolean))];
  if (runner && (!/^[a-zA-Z0-9-]+$/.test(options.runnerOrg ?? "") || !repos.length || repos.length > 20 || repos.some(repo => !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) || [".", ".."].includes(repo.split("/")[1]!)))) throw new Error("Provide --runner-org and 1–20 --runner-repos org/repo entries");
  if (!runner && options.githubCli) throw new Error("--gh-path requires runner configuration");
  validateWarmCanvases(options.warmCanvases);
  const config = structuredClone(template);
  config.main = `app/release/worker/${runner ? "local.worker.js" : "worker.js"}`;
  config.assets = { ...config.assets, directory: "app/release/assets" };
  config.vars = { ...config.vars, ENVIRONMENT: "local", CANVAS_PUBLIC_ORIGIN: options.origin };
  delete config.vars.GITHUB_TOKEN;
  delete config.vars.RUNNER_STATUS_TOKEN;
  if (runner) Object.assign(config.vars, { RUNNER_ORG: options.runnerOrg, RUNNER_REPOS: repos.join(","), RUNNER_NAME_PREFIX: "", RUNNER_STATUS_URL: "http://127.0.0.1:4788/api/status" });
  return config;
}

/** Refuse any pre-existing Serve configuration unless replacement was requested. */
export function assertServeAvailable(status: unknown, replace: boolean) {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Unrecognized Tailscale Serve status");
  const nonempty = (value: unknown): boolean => value !== null && value !== undefined && (typeof value !== "object" || Object.keys(value).length > 0);
  if (Object.values(status).some(nonempty) && !replace) throw new Error("Tailscale Serve already has configuration; inspect `tailscale serve status` and use --replace-serve to authorize replacing HTTPS 443");
  if (Object.values((status as { AllowFunnel?: Record<string, boolean> }).AllowFunnel ?? {}).some(Boolean)) throw new Error("Disable Tailscale Funnel before installing a private Canvas host");
}

export class HostManager {
  readonly data: string;
  readonly configPath: string;
  readonly plist: string;
  readonly log: string;
  private readonly home: string;
  private readonly domain: string;
  private readonly run: RunCommand;
  constructor(private readonly deps: HostDependencies = {}) {
    if ((deps.platform ?? process.platform) !== "darwin") throw new Error("canvas host currently requires macOS launchd");
    this.home = deps.home ?? homedir();
    this.data = resolve(deps.dataRoot ?? join(artifactDataRoot(), "host"));
    this.configPath = join(this.data, "host.json");
    this.plist = join(this.home, "Library/LaunchAgents", `${label}.plist`);
    this.log = join(this.data, "host.log");
    this.domain = `gui/${deps.uid ?? process.getuid!()}`;
    this.run = deps.runCommand ?? runCommand;
  }
  private async checked(command: string, args: string[]) {
    const result = await this.run(command, args);
    if (result.exitCode !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    return result;
  }
  private async config(): Promise<HostConfig> {
    if (!await Bun.file(this.configPath).exists()) throw new Error("Canvas host is not configured; run canvas host install");
    return Bun.file(this.configPath).json();
  }
  async status() {
    const supervisor = await this.run("/bin/launchctl", ["print", `${this.domain}/${label}`]);
    const loaded = supervisor.exitCode === 0;
    // One global launch agent is supported. A different --data-dir must never
    // stop or report another installation merely because the label matches.
    if (await Bun.file(this.plist).exists()) {
      const plist = await Bun.file(this.plist).text();
      if (!plist.includes(`<string>${xml(this.configPath)}</string>`)) throw new Error(`Canvas host launch agent belongs to a different data directory; use its --data-dir`);
    }
    if (loaded && !supervisor.stdout.split("\n").some(line => line.trim().replace(/^\d+\s*=\s*/, "") === this.configPath)) {
      throw new Error("Loaded Canvas host belongs to a different data directory; use its --data-dir");
    }
    const pid = Number(supervisor.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]) || undefined;
    const configured = await Bun.file(this.configPath).exists();
    let ready = false, origin: string | undefined;
    if (configured) {
      const config = await this.config(); origin = config.gateway.publicOrigin;
      if (pid) {
        if (this.deps.healthCheck) ready = await this.deps.healthCheck(config);
        else try {
          const response = await fetch(`http://127.0.0.1:${config.gateway.port}/health`, { headers: { host: new URL(origin).host, "tailscale-user-login": config.gateway.allowedLogin }, signal: AbortSignal.timeout(1000) });
          ready = response.ok; await response.body?.cancel();
        } catch {}
      }
    }
    return { configured, installedAtLogin: await Bun.file(this.plist).exists(), loaded, pid, ready, origin, data: this.data, log: this.log };
  }
  async install(options: HostInstallOptions) {
    const runner = options.runnerOrg !== undefined || options.runnerRepos !== undefined;
    hostRuntime({}, options); // Validate all user input before writes or downloads.
    if (await Bun.file(this.configPath).exists() || await Bun.file(this.plist).exists()) throw new Error("Canvas host already configured; use canvas host start. Existing data is preserved.");
    let tailscale: string | undefined;
    if (options.serve) {
      tailscale = Bun.which("tailscale") ?? undefined;
      if (!tailscale) throw new Error("Install and sign in to Tailscale before --serve");
      const result = await this.checked(tailscale, ["serve", "status", "--json"]);
      assertServeAvailable(JSON.parse(result.stdout), options.replaceServe ?? false);
    }
    const root = this.deps.packageRoot ?? PLUGIN_ROOT;
    const bundle = join(root, "dist", runner ? "runner-status" : "celld");
    const templatePath = join(bundle, "wrangler.jsonc");
    if (!await Bun.file(templatePath).exists()) throw new Error("Prepared host assets missing; run bun run build:package in the source checkout");
    const runtime = hostRuntime(Bun.JSONC.parse(await Bun.file(templatePath).text()) as Record<string, any>, options);
    const githubPath = options.githubCli ?? (runner ? Bun.which("gh") : undefined);
    const githubCli = runner && githubPath ? resolve(githubPath) : undefined;
    if (runner && (!githubCli || !await Bun.file(githubCli).exists())) throw new Error("Install gh and run gh auth login, or specify --gh-path");
    if (githubCli) {
      const auth = await this.run(githubCli, ["auth", "status", "--hostname", "github.com"]);
      if (auth.exitCode !== 0) throw new Error("GitHub authentication unavailable; run gh auth login on this host");
    }
    const portAvailable = this.deps.portAvailable ?? (port => { try { const socket = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); socket.stop(true); return true; } catch { return false; } });
    for (const port of [4788, 4789]) if (!portAvailable(port)) throw new Error(`Canvas host port ${port} is already in use`);
    const celld = this.deps.celldPath ?? process.env.ARTIFACTS_BUNDLED_CELLD ?? await (this.deps.ensureRuntime?.() ?? ensureCelldRuntime({ dataRoot: artifactDataRoot(), notify: console.error }));
    const esbuild = this.deps.esbuildPath ?? process.env.ARTIFACTS_BUNDLED_ESBUILD ?? createRequire(createRequire(join(root, "package.json")).resolve("esbuild/package.json")).resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
    for (const path of [celld, esbuild, ...(this.deps.serviceCommand ? [] : [join(root, "dist/host/service.js")])]) {
      if (!await Bun.file(path).exists()) throw new Error(`Required host executable or service missing: ${path}`);
    }
    const project = join(this.data, "server"), release = join(project, "app/release");
    await mkdir(release, { recursive: true, mode: 0o700 });
    await chmod(this.data, 0o700); await chmod(project, 0o700);
    await cp(runner ? join(bundle, "worker") : join(root, "dist/worker-app"), join(release, "worker"), { recursive: true });
    await cp(runner ? join(bundle, "assets") : join(root, "dist/cloudflare/assets"), join(release, "assets"), { recursive: true });
    await cp(esbuild, join(release, "esbuild"), { dereference: true }); await chmod(join(release, "esbuild"), 0o700);
    await cp(celld, join(release, "celld"), { dereference: true }); await chmod(join(release, "celld"), 0o700);
    let serviceCommand = this.deps.serviceCommand;
    if (!serviceCommand) {
      await cp(join(root, "dist/host/service.js"), join(release, "service.js"));
      let interpreter = process.execPath;
      if (process.env.ARTIFACTS_STANDALONE_EXECUTABLE) {
        interpreter = join(release, "canvas");
        await cp(process.env.ARTIFACTS_STANDALONE_EXECUTABLE, interpreter);
        await chmod(interpreter, 0o700);
      }
      serviceCommand = [interpreter, join(release, "service.js")];
    }
    if (runner) await cp(join(bundle, "runner-status.artifact.tsx"), join(release, "runner-status.artifact.tsx"));
    const config: HostConfig = {
      runtimeConfig: join(project, "wrangler.jsonc"), celld: join(release, "celld"), esbuild: join(release, "esbuild"), githubCli,
      keepWarm: options.keepWarm ?? false,
      warmGallery: options.warmGallery ?? false,
      warmCanvases: validateWarmCanvases(options.warmCanvases),
      runnerCanvas: runner ? join(release, "runner-status.artifact.tsx") : undefined,
      gateway: { publicOrigin: options.origin, allowedLogin: options.tailscaleLogin, upstreamOrigin: "http://127.0.0.1:4788", port: 4789 },
    };
    await writeFile(config.runtimeConfig, JSON.stringify(runtime, null, 2), { mode: 0o600, flag: "wx" });
    await writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    await mkdir(dirname(this.plist), { recursive: true });
    const args = this.deps.serviceCommand ? [...serviceCommand, "--config", this.configPath] : [...serviceCommand, this.configPath];
    await writeFile(join(this.data, "host.plist"), hostPlist(args, project, this.log, this.home), { mode: 0o600, flag: "wx" });
    await cp(join(this.data, "host.plist"), this.plist, { errorOnExist: true, force: false });
    const status = await this.start();
    if (tailscale) await this.checked(tailscale, ["serve", "--yes", "--bg", "--https=443", "http://127.0.0.1:4789"]);
    return status;
  }
  async start() {
    await this.config();
    if (!await Bun.file(this.plist).exists()) {
      const saved = join(this.data, "host.plist");
      if (!await Bun.file(saved).exists()) throw new Error("Saved host launch agent is missing; configuration and data remain preserved");
      await mkdir(dirname(this.plist), { recursive: true });
      await cp(saved, this.plist, { errorOnExist: true, force: false });
    }
    const current = await this.status();
    if (current.ready) return current;
    if (current.loaded) await this.stop();
    await this.checked("/bin/launchctl", ["enable", `${this.domain}/${label}`]);
    await this.checked("/bin/launchctl", ["bootstrap", this.domain, this.plist]);
    try {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const status = await this.status();
        if (status.ready) return status;
        await Bun.sleep(200);
      }
      throw new Error(`Canvas host did not become ready; see ${this.log}`);
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    const current = await this.status();
    if (current.loaded) await this.checked("/bin/launchctl", ["bootout", `${this.domain}/${label}`]);
    // bootout can return before the process exits. The lock protects subsequent
    // starts and backup from racing the celld child during graceful shutdown.
    const config = current.configured ? await this.config() : undefined;
    if (config && await Bun.file(join(dirname(config.runtimeConfig), "host-lock.sqlite")).exists()) {
      const lock = await acquireHostBackupLock(join(dirname(config.runtimeConfig), "host-lock.sqlite")); lock.close();
    }
    // SQLite becoming idle does not prove launchd has removed the old job.
    // Wait for removal before a caller can bootstrap the same label again.
    const now = this.deps.now ?? Date.now, sleep = this.deps.sleep ?? Bun.sleep;
    const deadline = now() + 60_000;
    for (;;) {
      const status = await this.status();
      if (!status.loaded) return status;
      if (now() >= deadline) throw new Error(`Canvas host launch agent did not unload within 60 seconds; see ${this.log}`);
      await sleep(200);
    }
  }
  async uninstall() { await this.stop(); await rm(this.plist, { force: true }); return this.status(); }
  async logs(lines = 100) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error("--lines must be between 1 and 1000");
    if (!await Bun.file(this.log).exists()) return "";
    const size = (await stat(this.log)).size, length = Math.min(size, 256 * 1024);
    const file = await open(this.log, "r");
    try { const buffer = Buffer.alloc(length); await file.read(buffer, 0, length, size - length); return buffer.toString("utf8").split(/(?<=\n)/).slice(-lines).join(""); }
    finally { await file.close(); }
  }
  async backup() {
    const config = await this.config(), wasLoaded = (await this.status()).loaded;
    await this.stop();
    let lock: Awaited<ReturnType<typeof acquireHostBackupLock>> | undefined;
    try {
      lock = await acquireHostBackupLock(join(dirname(config.runtimeConfig), "host-lock.sqlite"));
      const backups = join(this.data, "backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
      const archive = join(backups, `canvas-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`), temporary = `${archive}.tmp`;
      // Create privately before tar opens it; credentials can be in runtime config.
      await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
      try { await this.checked("/usr/bin/tar", ["-czf", temporary, "-C", this.data, "server", "host.json", "host.plist"]); await rename(temporary, archive); }
      finally { await rm(temporary, { force: true }); }
      return { archive };
    } finally { lock?.close(); if (wasLoaded) await this.start(); }
  }
}

export async function runHostCommand(args: ParsedArgs, dependencies: HostDependencies & { stdout?: (text: string) => void } = {}): Promise<boolean> {
  if (args.command !== "host") return false;
  const action = args.positionals[0];
  if (args.positionals.length !== 1 || !["install", "start", "stop", "status", "logs", "backup", "uninstall", "run"].includes(action!)) throw new Error("Usage: canvas host install | start | stop | status | logs | backup | uninstall");
  const allowed = new Set(action === "install" ? ["origin", "tailscale-login", "runner-org", "runner-repos", "gh-path", "serve", "replace-serve", "keep-warm", "warm-gallery", "warm-canvases", "data-dir"] : action === "run" ? ["config"] : action === "logs" ? ["lines", "data-dir"] : ["data-dir"]);
  for (const [name, value] of Object.entries(args.flags)) {
    if (!allowed.has(name)) throw new Error(`Unknown host ${action} option: --${name}`);
    if (!["serve", "replace-serve", "keep-warm", "warm-gallery"].includes(name) && value === true) throw new Error(`--${name} requires a value`);
  }
  if (action === "run") {
    const config = flagString(args.flags, "config"); if (!config) throw new Error("host run requires --config");
    await runHost(await Bun.file(config).json()); return true;
  }
  const manager = new HostManager({ ...dependencies, dataRoot: flagString(args.flags, "data-dir") ?? dependencies.dataRoot }), output = dependencies.stdout ?? (text => process.stdout.write(text));
  if (action === "logs") output(await manager.logs(args.flags.lines === undefined ? 100 : Number(args.flags.lines)));
  else {
    let result;
    if (action === "install") {
      result = await manager.install({ origin: flagString(args.flags, "origin") ?? "", tailscaleLogin: flagString(args.flags, "tailscale-login") ?? "", runnerOrg: flagString(args.flags, "runner-org"), runnerRepos: flagString(args.flags, "runner-repos"), githubCli: flagString(args.flags, "gh-path"), serve: flagBoolean(args.flags, "serve"), replaceServe: flagBoolean(args.flags, "replace-serve"), keepWarm: flagBoolean(args.flags, "keep-warm"), warmGallery: flagBoolean(args.flags, "warm-gallery"), warmCanvases: flagString(args.flags, "warm-canvases")?.split(",").map(name => name.trim()) });
    } else result = await manager[action as "start" | "stop" | "status" | "backup" | "uninstall"]();
    output(`${JSON.stringify(result, null, 2)}\n`);
  }
  return true;
}
