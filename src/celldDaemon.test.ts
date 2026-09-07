import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  launchdPlist,
  ServerDaemonManager,
  serverDaemonPaths,
  systemdUnit,
  writeServerReady,
  type CommandResult,
  type RunCommand,
} from "./celldDaemon";
import { tempDir } from "./test/fixtures";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const missing = (): CommandResult => ({ exitCode: 1, stdout: "", stderr: "not found" });

test("generated supervisor definitions preserve exact paths and only forward Canvas data home", () => {
  const root = join(tempDir(), 'space "quote" 100% $cash');
  const home = join(root, "home");
  const paths = serverDaemonPaths({ CANVAS_DATA_HOME: root, SECRET_TOKEN: "must-not-leak" }, "darwin", home);
  const input = {
    execPath: join(root, "bin", "bun$runtime"),
    cliEntry: join(root, "package", "src", "cli.ts"),
    port: 4786,
    paths,
  };
  const plist = launchdPlist(input);
  expect(plist).toContain(`<string>${paths.launchdLabel}</string>`);
  expect(plist).toContain("space &quot;quote&quot; 100% $cash");
  expect(plist).toContain("<key>CANVAS_DATA_HOME</key>");
  expect(plist).toContain("<key>ExitTimeOut</key>");
  expect(plist).not.toContain("SECRET_TOKEN");
  expect(plist).not.toContain("must-not-leak");

  const unit = systemdUnit(input);
  expect(unit).toContain('Environment="CANVAS_DATA_HOME=');
  expect(unit).toContain("100%% $cash");
  expect(unit).toContain("bun$runtime");
  expect(unit).toContain('ExecStart=:"/usr/bin/env" "--" ');
  expect(unit).toContain(`WorkingDirectory=${root.replaceAll("%", "%%")}`);
  expect(unit).toContain("KillMode=mixed");
  expect(unit).toContain("TimeoutStopSec=55s");
  expect(unit).toContain("StandardOutput=append:");
  expect(unit).not.toContain("SECRET_TOKEN");
});

test.skipIf(process.platform !== "linux" || !Bun.which("systemd-analyze"))("systemd accepts the generated unit with special path characters", async () => {
  const root = join(tempDir(), 'space "quote" 100% $cash');
  await mkdir(root, { recursive: true });
  const paths = serverDaemonPaths({ CANVAS_DATA_HOME: root }, "linux", root);
  const path = join(root, paths.systemdUnit);
  await Bun.write(path, systemdUnit({ execPath: "/bin/true", cliEntry: join(root, "cli.ts"), port: 4786, paths }));
  const child = Bun.spawn(["systemd-analyze", "verify", path], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
});

test("service identity is stable per data root and separates custom roots", () => {
  const home = tempDir();
  const first = serverDaemonPaths({ CANVAS_DATA_HOME: join(home, "one") }, "darwin", home);
  const again = serverDaemonPaths({ CANVAS_DATA_HOME: join(home, "one") }, "darwin", home);
  const second = serverDaemonPaths({ CANVAS_DATA_HOME: join(home, "two") }, "darwin", home);
  expect(first.launchdLabel).toBe(again.launchdLabel);
  expect(first.launchdLabel).not.toBe(second.launchdLabel);
  expect(first.systemdUnit).not.toBe(second.systemdUnit);
  expect(serverDaemonPaths({ XDG_CONFIG_HOME: join(home, "xdg") }, "linux", home).systemdPath).toStartWith(join(home, "xdg"));
});

test("launchd lifecycle keeps manual start transient and makes login opt-in reversible", async () => {
  const root = tempDir();
  const home = join(root, "home");
  const paths = serverDaemonPaths({ CANVAS_DATA_HOME: join(root, "data") }, "darwin", home);
  let loaded = false;
  let pid: number | undefined;
  const calls: string[] = [];
  const runCommand: RunCommand = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command !== "launchctl") throw new Error(`unexpected ${command}`);
    if (args[0] === "print") return loaded ? ok(pid ? `state = running\n\tpid = ${pid}\n` : "state = waiting\n") : missing();
    if (args[0] === "bootstrap") {
      loaded = true;
      pid = 912;
      await writeServerReady(paths.readyPath, { pid, port: 4786, url: "http://127.0.0.1:4786", stateDir: paths.stateDir });
      return ok();
    }
    if (args[0] === "bootout") {
      loaded = false;
      pid = undefined;
      return ok();
    }
    throw new Error(`unexpected launchctl ${args.join(" ")}`);
  };
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: paths.dataRoot }, platform: "darwin", home, uid: 501,
    execPath: join(root, "bun"), cliEntry: join(root, "installed", "src", "cli.ts"),
    runCommand, healthCheck: async url => url === "http://127.0.0.1:4786",
    prepareRuntime: async dataRoot => { expect(dataRoot).toBe(paths.dataRoot); },
    portAvailable: () => true, sleep: async () => {},
  });

  const manual = await manager.start();
  expect(manual).toMatchObject({ running: true, ready: true, installedAtLogin: false, pid: 912 });
  expect(existsSync(paths.launchdRuntimePath)).toBe(true);
  expect(existsSync(paths.launchdLoginPath)).toBe(false);
  await expect(manager.start()).rejects.toThrow("already ready");

  await manager.stop();
  const login = await manager.start({ atLogin: true });
  expect(login.installedAtLogin).toBe(true);
  expect(existsSync(paths.launchdLoginPath)).toBe(true);
  const uninstalled = await manager.uninstall();
  expect(uninstalled).toMatchObject({ loaded: false, running: false, ready: false, installedAtLogin: false });
  expect(existsSync(paths.launchdLoginPath)).toBe(false);
  expect(calls.some(call => call.includes(`bootout gui/501/${paths.launchdLabel}`))).toBe(true);
});

test("stop unloads a launchd job even when its process has no PID", async () => {
  const root = tempDir();
  let loaded = true;
  let bootouts = 0;
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: join(root, "data") }, platform: "darwin", home: join(root, "home"), uid: 501,
    runCommand: async (_command, args) => {
      if (args[0] === "print") return loaded ? ok("state = waiting\n") : missing();
      if (args[0] === "bootout") { loaded = false; bootouts += 1; return ok(); }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    prepareRuntime: async () => {}, portAvailable: () => true, sleep: async () => {},
  });
  expect(await manager.status()).toMatchObject({ loaded: true, running: false, detail: "loaded but process is not running" });
  expect(await manager.stop()).toMatchObject({ loaded: false, running: false });
  expect(bootouts).toBe(1);
});

test("systemd status parses keyed properties in any order and requires matching readiness PID", async () => {
  const root = tempDir();
  const paths = serverDaemonPaths({ CANVAS_DATA_HOME: join(root, "data") }, "linux", join(root, "home"));
  await writeServerReady(paths.readyPath, { pid: 88, port: 4786, url: "http://127.0.0.1:4786", stateDir: paths.stateDir });
  await Bun.write(paths.configPath, JSON.stringify({ port: 4786, stateDir: paths.stateDir }));
  let healthCalls = 0;
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: paths.dataRoot }, platform: "linux", home: join(root, "home"),
    runCommand: async (_command, args) => args.includes("is-enabled")
      ? ok("enabled\n")
      : ok("MainPID=88\nLoadState=loaded\nActiveState=active\n"),
    healthCheck: async () => { healthCalls += 1; return true; },
    prepareRuntime: async () => {}, portAvailable: () => true,
  });
  await mkdir(manager.paths.daemonDir, { recursive: true });
  expect(await manager.status()).toMatchObject({ manager: "systemd", installedAtLogin: true, loaded: true, running: true, ready: true, pid: 88 });
  expect(healthCalls).toBe(1);

  await writeServerReady(paths.readyPath, { pid: 89, port: 4786, url: "http://127.0.0.1:4786", stateDir: paths.stateDir });
  expect(await manager.status()).toMatchObject({ running: true, ready: false, detail: "running but has not published matching readiness" });
  expect(healthCalls).toBe(1);
});

test("systemd manual start, stop, login enable and uninstall use distinct lifecycle actions", async () => {
  const root = tempDir();
  const home = join(root, "home");
  const paths = serverDaemonPaths({ CANVAS_DATA_HOME: join(root, "data") }, "linux", home);
  let active = false;
  let enabled = false;
  let pid = 0;
  const actions: string[] = [];
  const runCommand: RunCommand = async (command, args) => {
    expect(command).toBe("systemctl");
    const action = args[1]!;
    actions.push(args.slice(1).join(" "));
    if (action === "show") {
      const loaded = existsSync(paths.systemdPath) ? "loaded" : "not-found";
      return ok(`ActiveState=${active ? "active" : "inactive"}\nMainPID=${pid}\nLoadState=${loaded}\n`);
    }
    if (action === "is-enabled") return enabled ? ok("enabled\n") : missing();
    if (action === "daemon-reload") return ok();
    if (action === "start" || action === "enable") {
      if (action === "enable") enabled = true;
      active = true;
      pid = 611;
      await writeServerReady(paths.readyPath, { pid, port: 4786, url: "http://127.0.0.1:4786", stateDir: paths.stateDir });
      return ok();
    }
    if (action === "stop") { active = false; pid = 0; return ok(); }
    if (action === "disable") { enabled = false; return ok(); }
    throw new Error(`unexpected systemctl ${args.join(" ")}`);
  };
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: paths.dataRoot }, platform: "linux", home,
    runCommand, healthCheck: async () => true, prepareRuntime: async () => {},
    portAvailable: () => true, sleep: async () => {},
  });

  expect(await manager.start()).toMatchObject({ running: true, ready: true, installedAtLogin: false });
  expect(actions).toContain(`start ${paths.systemdUnit}`);
  expect(await manager.stop()).toMatchObject({ loaded: true, running: false, ready: false });
  expect(await manager.start({ atLogin: true })).toMatchObject({ running: true, ready: true, installedAtLogin: true });
  expect(actions).toContain(`enable --now ${paths.systemdUnit}`);
  expect(await manager.uninstall()).toMatchObject({ loaded: false, running: false, installedAtLogin: false });
  expect(existsSync(paths.systemdPath)).toBe(false);
  expect(actions).toContain(`disable ${paths.systemdUnit}`);
});

test("startup reports a supervisor cleanup failure instead of claiming it stopped", async () => {
  const root = tempDir();
  let loaded = false;
  let now = 0;
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: join(root, "data") }, platform: "darwin", home: join(root, "home"), uid: 501,
    runCommand: async (_command, args) => {
      if (args[0] === "print") return loaded ? ok("state = waiting\n") : missing();
      if (args[0] === "bootstrap") { loaded = true; return ok(); }
      if (args[0] === "bootout") return { exitCode: 1, stdout: "", stderr: "permission denied" };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    prepareRuntime: async () => {}, portAvailable: () => true,
    now: () => now, sleep: async () => { now += 200_000; },
  });
  await expect(manager.start()).rejects.toThrow("Cleanup also failed: launchctl bootout failed: permission denied");
  expect(loaded).toBe(true);
});

test("logs returns only a bounded tail", async () => {
  const root = tempDir();
  const manager = new ServerDaemonManager({
    env: { CANVAS_DATA_HOME: join(root, "data") }, platform: "darwin", home: join(root, "home"),
    runCommand: async () => missing(), prepareRuntime: async () => {}, portAvailable: () => true,
  });
  await mkdir(manager.paths.daemonDir, { recursive: true });
  await Bun.write(manager.paths.logPath, Array.from({ length: 2000 }, (_, index) => `${index}:${"x".repeat(200)}\n`).join(""));
  const logs = await manager.logs(3);
  expect(logs.contents).toBe(`1997:${"x".repeat(200)}\n1998:${"x".repeat(200)}\n1999:${"x".repeat(200)}\n`);
  await expect(manager.logs(1001)).rejects.toThrow("between 1 and 1000");
});

test("unsupported supervisors report the required service managers", () => {
  expect(() => new ServerDaemonManager({ platform: "win32" })).toThrow("background services require macOS launchd or Linux systemd");
});
