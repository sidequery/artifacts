import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { canvasDataRoot, ensureCelldRuntime } from "./celldRuntime";
import { CLI_ENTRY, PLUGIN_ROOT } from "./paths";

export const SERVER_PORT = 4786;
export const LAUNCHD_LABEL = "com.sidequery.canvas.server";
export const SYSTEMD_UNIT = "sidequery-canvas-server.service";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export type ServerReadyState = {
  pid: number;
  port: number;
  url: string;
  stateDir: string;
  readyAt: string;
};

type ServerConfig = { port: number; stateDir: string };
type SupervisorState = { loaded: boolean; running: boolean; pid?: number };

export type ServerDaemonStatus = {
  manager: "launchd" | "systemd";
  installedAtLogin: boolean;
  loaded: boolean;
  running: boolean;
  ready: boolean;
  pid?: number;
  url?: string;
  logPath: string;
  detail: string;
};

export type ServerDaemonDependencies = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  execPath?: string;
  cliEntry?: string;
  runCommand?: RunCommand;
  healthCheck?: (url: string) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  portAvailable?: (port: number) => boolean;
  prepareRuntime?: (dataRoot: string) => Promise<void>;
};

export type ServerDaemonPaths = ReturnType<typeof serverDaemonPaths>;

export function serverDaemonPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  const dataRoot = canvasDataRoot(env, platform, home);
  const daemonDir = join(dataRoot, "daemon");
  const serviceSuffix = createHash("sha256").update(dataRoot).digest("hex").slice(0, 12);
  const launchdLabel = `${LAUNCHD_LABEL}.${serviceSuffix}`;
  const systemdUnit = `sidequery-canvas-server-${serviceSuffix}.service`;
  const systemdConfig = platform === "linux" && env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, ".config");
  return {
    dataRoot,
    daemonDir,
    stateDir: join(dataRoot, "server"),
    configPath: join(daemonDir, "server.json"),
    readyPath: join(daemonDir, "ready.json"),
    logPath: join(daemonDir, "server.log"),
    launchdLabel,
    systemdUnit,
    launchdRuntimePath: join(daemonDir, `${launchdLabel}.plist`),
    launchdLoginPath: join(home, "Library", "LaunchAgents", `${launchdLabel}.plist`),
    systemdPath: join(systemdConfig, "systemd", "user", systemdUnit),
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

function systemdPathValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Canvas data paths containing line breaks are unsupported by systemd");
  return value.replaceAll("\\", "\\\\").replaceAll("%", "%%");
}

function serverArguments(input: { execPath: string; cliEntry: string; port: number; paths: ServerDaemonPaths }): string[] {
  return [
    input.execPath,
    input.cliEntry,
    "server",
    "--port",
    String(input.port),
    "--state-dir",
    input.paths.stateDir,
    "--managed-ready",
    input.paths.readyPath,
  ];
}

export function launchdPlist(input: { execPath: string; cliEntry: string; port: number; paths: ServerDaemonPaths }): string {
  const args = serverArguments(input).map(value => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${input.paths.launchdLabel}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CANVAS_DATA_HOME</key>
      <string>${xml(input.paths.dataRoot)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ExitTimeOut</key>
    <integer>55</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>WorkingDirectory</key>
    <string>${xml(input.paths.dataRoot)}</string>
    <key>StandardOutPath</key>
    <string>${xml(input.paths.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(input.paths.logPath)}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(input: { execPath: string; cliEntry: string; port: number; paths: ServerDaemonPaths }): string {
  // systemd restricts characters in its executable path. env immediately execs
  // the absolute Bun path passed as an argument, without a shell or PATH lookup.
  // The colon prefix disables systemd dollar expansion for these literal paths.
  const command = ["/usr/bin/env", "--", ...serverArguments(input)].map(systemdQuote).join(" ");
  return `[Unit]
Description=Sidequery Canvas local server
After=network.target

[Service]
Type=simple
Environment=${systemdQuote(`CANVAS_DATA_HOME=${input.paths.dataRoot}`)}
WorkingDirectory=${systemdPathValue(input.paths.dataRoot)}
ExecStart=:${command}
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=55s
StandardOutput=append:${systemdPathValue(input.paths.logPath)}
StandardError=append:${systemdPathValue(input.paths.logPath)}

[Install]
WantedBy=default.target
`;
}

async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(750) })).ok;
  } catch {
    return false;
  }
}

function commandError(command: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`${command} failed: ${detail}`);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function writeServerReady(path: string, state: Omit<ServerReadyState, "readyAt">): Promise<void> {
  await atomicJson(path, { ...state, readyAt: new Date().toISOString() });
}

export async function clearServerReady(path: string, pid = process.pid): Promise<void> {
  const current = await readJson<ServerReadyState>(path);
  if (current?.pid === pid) await rm(path, { force: true });
}

export class ServerDaemonManager {
  readonly paths: ServerDaemonPaths;
  readonly platform: NodeJS.Platform;
  readonly manager: "launchd" | "systemd";
  private readonly uid: number;
  private readonly execPath: string;
  private readonly cliEntry: string;
  private readonly runCommand: RunCommand;
  private readonly healthCheck: (url: string) => Promise<boolean>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly portAvailable: (port: number) => boolean;
  private readonly prepareRuntime: (dataRoot: string) => Promise<void>;

  constructor(dependencies: ServerDaemonDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    if (this.platform !== "darwin" && this.platform !== "linux") {
      throw new Error(`Canvas server background service is unsupported on ${this.platform}; background services require macOS launchd or Linux systemd.`);
    }
    const home = dependencies.home ?? homedir();
    this.paths = serverDaemonPaths(dependencies.env, this.platform, home);
    this.manager = this.platform === "darwin" ? "launchd" : "systemd";
    this.uid = dependencies.uid ?? process.getuid?.() ?? 0;
    this.execPath = resolve(dependencies.execPath ?? process.execPath);
    this.cliEntry = resolve(dependencies.cliEntry ?? CLI_ENTRY);
    this.runCommand = dependencies.runCommand ?? defaultRunCommand;
    this.healthCheck = dependencies.healthCheck ?? defaultHealthCheck;
    this.sleep = dependencies.sleep ?? Bun.sleep;
    this.now = dependencies.now ?? Date.now;
    this.portAvailable = dependencies.portAvailable ?? (port => {
      try {
        const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        listener.stop(true);
        return true;
      } catch {
        return false;
      }
    });
    this.prepareRuntime = dependencies.prepareRuntime ?? (async dataRoot => {
      if (!existsSync(join(PLUGIN_ROOT, "dist", "celld", "wrangler.jsonc"))) {
        throw new Error("Packaged Canvas server assets are missing. From a source checkout, run bun run build:package first.");
      }
      await ensureCelldRuntime({ dataRoot, notify: message => console.error(message) });
    });
  }

  private launchdDomain(): string {
    return `gui/${this.uid}`;
  }

  private async supervisorState(): Promise<SupervisorState> {
    if (this.manager === "launchd") {
      const result = await this.runCommand("launchctl", ["print", `${this.launchdDomain()}/${this.paths.launchdLabel}`]);
      if (result.exitCode !== 0) return { loaded: false, running: false };
      const pid = Number(result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
      return { loaded: true, running: Number.isInteger(pid) && pid > 0, pid: pid || undefined };
    }
    const result = await this.runCommand("systemctl", ["--user", "show", this.paths.systemdUnit, "--property=LoadState", "--property=ActiveState", "--property=MainPID"]);
    if (result.exitCode !== 0) return { loaded: false, running: false };
    const properties = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => {
      const separator = line.indexOf("=");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const pid = Number(properties.MainPID);
    const loaded = properties.LoadState !== undefined && properties.LoadState !== "not-found";
    return { loaded, running: properties.ActiveState === "active" && Number.isInteger(pid) && pid > 0, pid: pid || undefined };
  }

  private async installedAtLogin(): Promise<boolean> {
    if (this.manager === "launchd") return existsSync(this.paths.launchdLoginPath);
    const result = await this.runCommand("systemctl", ["--user", "is-enabled", this.paths.systemdUnit]);
    return result.exitCode === 0 && result.stdout.trim() === "enabled";
  }

  async status(): Promise<ServerDaemonStatus> {
    const [supervisor, installed, config, ready] = await Promise.all([
      this.supervisorState(),
      this.installedAtLogin(),
      readJson<ServerConfig>(this.paths.configPath),
      readJson<ServerReadyState>(this.paths.readyPath),
    ]);
    const ownsReady = Boolean(
      supervisor.running &&
      supervisor.pid === ready?.pid &&
      config?.port === ready?.port &&
      config?.stateDir === ready?.stateDir,
    );
    const healthy = ownsReady && ready ? await this.healthCheck(ready.url) : false;
    const detail = !supervisor.loaded
      ? "stopped"
      : !supervisor.running
        ? "loaded but process is not running"
      : healthy
        ? "ready"
        : ownsReady
          ? "running but health check failed"
          : "running but has not published matching readiness";
    return {
      manager: this.manager,
      installedAtLogin: installed,
      loaded: supervisor.loaded,
      running: supervisor.running,
      ready: healthy,
      pid: supervisor.pid,
      url: healthy ? ready?.url : undefined,
      logPath: this.paths.logPath,
      detail,
    };
  }

  async start(options: { atLogin?: boolean; port?: number } = {}): Promise<ServerDaemonStatus> {
    const port = options.port ?? SERVER_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("server start --port must be an integer between 1 and 65535");
    const current = await this.status();
    if (current.running) throw new Error(`Canvas server is already ${current.detail}${current.url ? ` at ${current.url}` : ""}.`);
    await this.prepareRuntime(this.paths.dataRoot);
    const loaded = await this.supervisorState();
    if (loaded.loaded) await this.stopSupervisor();
    if (!this.portAvailable(port)) throw new Error(`Canvas server port ${port} is already in use.`);
    await mkdir(this.paths.daemonDir, { recursive: true, mode: 0o700 });
    await rm(this.paths.readyPath, { force: true });
    const config: ServerConfig = { port, stateDir: this.paths.stateDir };
    await atomicJson(this.paths.configPath, config);
    const definition = { execPath: this.execPath, cliEntry: this.cliEntry, port, paths: this.paths };

    try {
      if (this.manager === "launchd") {
        const persistent = options.atLogin || current.installedAtLogin;
        const path = persistent ? this.paths.launchdLoginPath : this.paths.launchdRuntimePath;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, launchdPlist(definition), { mode: 0o600 });
        const result = await this.runCommand("launchctl", ["bootstrap", this.launchdDomain(), path]);
        if (result.exitCode !== 0) throw commandError("launchctl bootstrap", result);
      } else {
        await mkdir(dirname(this.paths.systemdPath), { recursive: true, mode: 0o700 });
        await writeFile(this.paths.systemdPath, systemdUnit(definition), { mode: 0o600 });
        const reload = await this.runCommand("systemctl", ["--user", "daemon-reload"]);
        if (reload.exitCode !== 0) throw commandError("systemctl --user daemon-reload", reload);
        const action = options.atLogin || current.installedAtLogin
          ? ["enable", "--now", this.paths.systemdUnit]
          : ["start", this.paths.systemdUnit];
        const result = await this.runCommand("systemctl", ["--user", ...action]);
        if (result.exitCode !== 0) throw commandError(`systemctl --user ${action[0]}`, result);
      }
    } catch (error) {
      return await this.failStart(error);
    }

    try {
      const deadline = this.now() + 190_000;
      while (this.now() < deadline) {
        const status = await this.status();
        if (status.ready) return status;
        await this.sleep(100);
      }
      throw new Error(`Canvas server did not become ready within 190 seconds. See ${this.paths.logPath}`);
    } catch (error) {
      return await this.failStart(error);
    }
  }

  private async failStart(error: unknown): Promise<never> {
    let cleanupError: unknown;
    try { await this.stopSupervisor(); }
    catch (caught) { cleanupError = caught; }
    await rm(this.paths.readyPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    if (cleanupError) {
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${message} Cleanup also failed: ${cleanup}. Check \`canvas server status\` and \`canvas server logs\`.`);
    }
    throw new Error(`${message} The created service was stopped.`);
  }

  private async stopSupervisor(): Promise<void> {
    const state = await this.supervisorState();
    if (state.loaded) {
      const result = this.manager === "launchd"
        ? await this.runCommand("launchctl", ["bootout", `${this.launchdDomain()}/${this.paths.launchdLabel}`])
        : await this.runCommand("systemctl", ["--user", "stop", this.paths.systemdUnit]);
      if (result.exitCode !== 0) throw commandError(this.manager === "launchd" ? "launchctl bootout" : "systemctl --user stop", result);
    }
  }

  async stop(): Promise<ServerDaemonStatus> {
    await this.stopSupervisor();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const supervisor = await this.supervisorState();
      const status = await this.status();
      if (this.manager === "launchd" ? !supervisor.loaded : !supervisor.running) {
        await rm(this.paths.readyPath, { force: true });
        return status;
      }
      await this.sleep(100);
    }
    throw new Error(`Canvas server did not stop within 60 seconds. See ${this.paths.logPath}`);
  }

  async uninstall(): Promise<ServerDaemonStatus> {
    await this.stop();
    if (this.manager === "launchd") {
      await rm(this.paths.launchdLoginPath, { force: true });
      await rm(this.paths.launchdRuntimePath, { force: true });
    } else {
      const disable = await this.runCommand("systemctl", ["--user", "disable", this.paths.systemdUnit]);
      if (disable.exitCode !== 0 && !disable.stderr.includes("does not exist")) throw commandError("systemctl --user disable", disable);
      await rm(this.paths.systemdPath, { force: true });
      const reload = await this.runCommand("systemctl", ["--user", "daemon-reload"]);
      if (reload.exitCode !== 0) throw commandError("systemctl --user daemon-reload", reload);
    }
    return await this.status();
  }

  async logs(lines = 100): Promise<{ path: string; contents: string }> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) throw new Error("server logs --lines must be an integer between 1 and 1000");
    let size: number;
    try { size = (await stat(this.paths.logPath)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: this.paths.logPath, contents: "" };
      throw error;
    }
    const length = Math.min(size, 256 * 1024);
    const handle = await open(this.paths.logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const chunks = buffer.toString("utf8").split(/(?<=\n)/);
      return { path: this.paths.logPath, contents: chunks.slice(-lines).join("") };
    } finally {
      await handle.close();
    }
  }
}
