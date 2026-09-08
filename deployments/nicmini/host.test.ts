import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { HostManager, assertServeAvailable, hostRuntime, runHostCommand } from "./host";
import { parseArgs } from "../../src/args";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const options = { origin: "https://host.tailnet.ts.net", tailscaleLogin: "owner@example.com" };
async function fixture(removalPrints = 0, virtualTime = false) {
  let now = 0;
  const root = await mkdtemp(join(tmpdir(), "canvas-host-test-")); directories.push(root);
  for (const path of ["dist/celld", "dist/worker-app", "dist/cloudflare/assets", "dist/nicmini", "node_modules/.bin"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "dist/celld/wrangler.jsonc"), JSON.stringify({ main: "../worker-app/worker.js", assets: { directory: "../cloudflare/assets" }, vars: { ENVIRONMENT: "local" } }));
  for (const path of ["dist/worker-app/worker.js", "dist/cloudflare/assets/index.html", "dist/nicmini/service.js", "node_modules/.bin/esbuild", "celld"]) await writeFile(join(root, path), "fixture");
  const commands: string[][] = []; let loaded = false; let failBackup = false; let removing = -1;
  const manager = new HostManager({ packageRoot: root, dataRoot: join(root, "data"), home: root, platform: "darwin", uid: 501, celldPath: join(root, "celld"), esbuildPath: join(root, "node_modules/.bin/esbuild"), healthCheck: async () => true, portAvailable: () => true,
    ...(virtualTime ? { now: () => now, sleep: async (milliseconds: number) => { now += milliseconds; } } : {}),
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === "print" && removing >= 0 && removing-- === 0) loaded = false;
      if (args[0] === "print") return { exitCode: loaded ? 0 : 1, stdout: loaded ? ` pid = 123\n 2 = ${join(root, "data/host.json")}\n` : "", stderr: "" };
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") { removing = removalPrints; if (!removalPrints) loaded = false; }
      if (command === "/usr/bin/tar" && failBackup) return { exitCode: 1, stdout: "", stderr: "archive failed" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { root, manager, commands, failBackup: () => { failBackup = true; } };
}

test("core host has stable in-project assets and no runner or credentials", () => {
  const runtime = hostRuntime({ vars: { GITHUB_TOKEN: "secret", RUNNER_STATUS_TOKEN: "secret" } }, options);
  expect(runtime.main).toBe("app/release/worker/worker.js");
  expect(runtime.assets.directory).toBe("app/release/assets");
  expect(runtime.vars).toEqual({ ENVIRONMENT: "local", CANVAS_PUBLIC_ORIGIN: options.origin });
});
test("validates complete runner configuration, origins and Serve authorization", () => {
  for (const input of [{ runnerOrg: "org" }, { runnerRepos: "org/repo" }, { runnerOrg: "org", runnerRepos: "org/.." }, { origin: "http://host" }, { tailscaleLogin: "a b" }, { replaceServe: true }]) expect(() => hostRuntime({}, { ...options, ...input })).toThrow();
  const runtime = hostRuntime({}, { ...options, runnerOrg: "org", runnerRepos: "org/one,org/two,org/one" });
  expect(runtime.vars.RUNNER_REPOS).toBe("org/one,org/two");
  expect(runtime.main).toBe("app/release/worker/local.worker.js");
  expect(() => assertServeAvailable({}, false)).not.toThrow();
  expect(() => assertServeAvailable({ Web: { host: {} } }, false)).toThrow("already has configuration");
  expect(() => assertServeAvailable({ Web: { host: {} } }, true)).not.toThrow();
  expect(() => assertServeAvailable({ AllowFunnel: { host: true } }, true)).toThrow("Funnel");
});
test("install copies runtime outside package; stop/start and uninstall retain state", async () => {
  const { root, manager, commands } = await fixture();
  expect((await manager.install(options)).ready).toBe(true);
  const config = await Bun.file(manager.configPath).json();
  expect(config.githubCli).toBeUndefined();
  expect(config.celld).toBe(join(manager.data, "server/app/release/celld"));
  expect(await Bun.file(config.celld).text()).toBe("fixture");
  await writeFile(join(manager.data, "server/user-data"), "keep me");
  await rm(join(root, "dist"), { recursive: true });
  expect((await manager.stop()).loaded).toBe(false);
  expect((await manager.start()).ready).toBe(true);
  expect((await manager.uninstall()).installedAtLogin).toBe(false);
  expect(await Bun.file(join(manager.data, "server/user-data")).text()).toBe("keep me");
  expect((await manager.start()).ready).toBe(true);
  expect(commands.some(command => command[0].includes("tailscale"))).toBe(false);
  await expect(manager.install(options)).rejects.toThrow("already configured");
});
test("failed backup restarts a previously loaded service, leaves stopped service stopped", async () => {
  const { manager, failBackup } = await fixture(); await manager.install(options);
  const lock = new Database(join(manager.data, "server/host-lock.sqlite")); lock.close();
  failBackup();
  await expect(manager.backup()).rejects.toThrow("archive failed");
  expect((await manager.status()).ready).toBe(true);
  await manager.stop();
  await expect(manager.backup()).rejects.toThrow("archive failed");
  expect((await manager.status()).loaded).toBe(false);
});
test("missing assets and invalid CLI flags fail before installation", async () => {
  const { root, manager } = await fixture(); await rm(join(root, "dist/celld/wrangler.jsonc"));
  await expect(manager.install(options)).rejects.toThrow("assets missing");
  expect(await Bun.file(manager.configPath).exists()).toBe(false);
  await expect(runHostCommand(parseArgs(["host", "install", "--runner-org"]))).rejects.toThrow("requires a value");
  await expect(runHostCommand(parseArgs(["host", "stop", "--serve"]))).rejects.toThrow("Unknown");
  expect(await runHostCommand(parseArgs(["version"]))).toBe(false);
});

test("another data directory cannot manage the globally registered host", async () => {
  const { root, manager } = await fixture(); await manager.install(options);
  const commands: string[][] = [];
  const other = new HostManager({ dataRoot: join(root, "other"), home: root, platform: "darwin", uid: 501,
    runCommand: async (command, args) => { commands.push([command, ...args]); return { exitCode: 0, stdout: `pid = 123\n2 = ${manager.configPath}\n`, stderr: "" }; },
  });
  await expect(other.status()).rejects.toThrow("different data directory");
  await expect(other.stop()).rejects.toThrow("different data directory");
  await expect(other.uninstall()).rejects.toThrow("different data directory");
  expect(commands.every(command => command[1] === "print")).toBe(true);
  expect(await Bun.file(manager.plist).exists()).toBe(true);
  // A stale/replaced login plist must not make a loaded foreign process ours.
  await rm(manager.plist);
  await expect(other.status()).rejects.toThrow("Loaded Canvas host belongs");
});

test("runner installation preserves root gallery and copies optional collector assets", async () => {
  const { root, manager } = await fixture();
  for (const path of ["dist/runner-status/worker", "dist/runner-status/assets"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "dist/runner-status/wrangler.jsonc"), JSON.stringify({ vars: {}, durable_objects: { bindings: [{ name: "RUNNER_STATUS", class_name: "RunnerStatus" }] } }));
  for (const path of ["dist/runner-status/worker/local.worker.js", "dist/runner-status/assets/index.html", "dist/runner-status/runner-status.artifact.tsx", "gh"]) await writeFile(join(root, path), "runner fixture");
  await manager.install({ ...options, runnerOrg: "org", runnerRepos: "org/repo", githubCli: join(root, "gh"), warmGallery: true, warmCanvases: ["runner-status"] });
  const config = await Bun.file(manager.configPath).json();
  expect(config.gateway.landingPath).toBeUndefined();
  expect(config.keepWarm).toBe(false);
  expect(config.warmGallery).toBe(true);
  expect(config.warmCanvases).toEqual(["runner-status"]);
  expect(config.githubCli).toBe(join(root, "gh"));
  expect(await Bun.file(config.runnerCanvas).text()).toBe("runner fixture");
  const runtime = await Bun.file(config.runtimeConfig).json();
  expect(runtime.vars.RUNNER_REPOS).toBe("org/repo");
  expect(runtime.vars.GITHUB_TOKEN).toBeUndefined();
  expect(runtime.durable_objects.bindings).toContainEqual({ name: "RUNNER_STATUS", class_name: "RunnerStatus" });
});


test("stop waits for asynchronous launchd removal before restart", async () => {
  const { manager, commands } = await fixture(2);
  await manager.install(options);
  commands.length = 0;
  expect((await manager.stop()).loaded).toBe(false);
  expect((await manager.start()).ready).toBe(true);
  const bootout = commands.findIndex(command => command[1] === "bootout");
  const bootstrap = commands.findIndex(command => command[1] === "bootstrap");
  expect(bootout).toBeGreaterThanOrEqual(0);
  expect(commands.slice(bootout + 1, bootstrap).filter(command => command[1] === "print").length).toBeGreaterThanOrEqual(3);
});


test("stop fails after bounded wait when launchd retains the job", async () => {
  const { manager, commands } = await fixture(1000, true);
  await manager.install(options); commands.length = 0;
  await expect(manager.stop()).rejects.toThrow("did not unload within 60 seconds");
  expect(commands.some(command => command[1] === "bootstrap")).toBe(false);
});
