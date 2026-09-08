import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");

async function execute(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await child.exited;
  return { code, stdout: await stdout, stderr: await stderr };
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const result = await execute(command, cwd, env);
  if (result.code !== 0) throw new Error(`${command.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function reservePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function startNativeServer(
  artifact: string,
  consumer: string,
  stateDir: string,
  port: number,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn([process.execPath, artifact, "server", "--port", String(port), "--state-dir", stateDir], {
    // Match service-manager environments: no interactive Bun/Node PATH entries.
    cwd: consumer, env: { ...env, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const errors: string[] = [];
  const stderr = (async () => {
    if (!(child.stderr instanceof ReadableStream)) return;
    for await (const chunk of child.stderr) errors.push(new TextDecoder().decode(chunk));
  })();
  try {
    return { child, url: await readyUrl(child, 180_000), errors, stderr };
  } catch (error) {
    child.kill();
    await child.exited;
    await stderr;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${errors.join("")}`);
  }
}

async function stopNativeServer(server: Awaited<ReturnType<typeof startNativeServer>>) {
  server.child.kill("SIGINT");
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    server.child.exited.then(() => true),
    new Promise<false>(resolve => { watchdog = setTimeout(() => resolve(false), 50_000); }),
  ]).finally(() => clearTimeout(watchdog));
  if (!stopped) {
    server.child.kill("SIGKILL");
    await server.child.exited;
    await server.stderr;
    throw new Error(`installed native server did not stop gracefully\n${server.errors.join("")}`);
  }
  const code = await server.child.exited;
  await server.stderr;
  if (code !== 0) throw new Error(`installed native server exited ${code}\n${server.errors.join("")}`);
}

async function readyUrl(child: ReturnType<typeof Bun.spawn>, timeoutMilliseconds = 15_000): Promise<string> {
  if (!(child.stdout instanceof ReadableStream)) throw new Error("gallery stdout is unavailable");
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const ready = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`gallery exited before listening:\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      try {
        const result = JSON.parse(output) as { ok?: boolean; url?: string };
        if (result.ok && result.url) return result.url;
      } catch { /* Wait for the complete, pretty-printed startup object. */ }
    }
  })();
  try {
    return await Promise.race([
      ready,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("server startup timed out")), timeoutMilliseconds); }),
    ]);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

test("published tarball runs the CLI, gallery, and stdio MCP outside a checkout", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "sidequery-artifacts-package-"));
  const archiveDirectory = join(temporary, "archive");
  const consumer = join(temporary, "consumer");
  const clientDirectory = join(temporary, "mcp-client");
  const home = join(temporary, "home");
  const artifacts = join(consumer, "artifacts");
  const history = join(consumer, "history.sqlite");
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(clientDirectory, { recursive: true });
  mkdirSync(home, { recursive: true });
  const isolatedEnv = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(temporary, "cache"),
    XDG_DATA_HOME: join(temporary, "data"),
    BUN_INSTALL_CACHE_DIR: join(temporary, "bun-cache"),
    ARTIFACTS_DATA_HOME: join(temporary, "artifact-data"),
    HERDR_PLUGIN_STATE_DIR: join(temporary, "herdr-state"),
  };
  let gallery: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // Release jobs supply the exact archive that will be published.
    const archive = process.env.ARTIFACTS_PACKAGE_ARCHIVE
      ? resolve(process.env.ARTIFACTS_PACKAGE_ARCHIVE)
      : join(archiveDirectory, `sidequery-artifacts-${(await Bun.file(join(root, "package.json")).json()).version}.tgz`);
    if (!process.env.ARTIFACTS_PACKAGE_ARCHIVE) {
      await run([
        process.execPath, "pm", "pack", "--ignore-scripts", "--destination", archiveDirectory,
      ], root, isolatedEnv);
    }
    const listing = await run(["tar", "-tzf", archive], root, isolatedEnv);
    expect(listing.stdout).toContain("package/dist/celld/wrangler.jsonc");
    expect(listing.stdout).toContain("package/dist/worker-app/worker.js");
    expect(listing.stdout).toContain("package/dist/cloudflare/assets/index.html");
    expect(listing.stdout).toContain("package/docs/daemon.md");
    expect(listing.stdout).toContain("package/docs/releasing.md");
    expect(listing.stdout).toContain("package/src/cli.ts");
    expect(listing.stdout).not.toMatch(/\.test\.[cm]?[jt]sx?$/m);
    expect(listing.stdout).not.toContain("package/scripts/");
    expect(listing.stdout).not.toContain("package/deployments/");
    expect(listing.stdout).not.toContain("package/dist/runner-status/");

    await Bun.write(join(consumer, "package.json"), JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@sidequery/artifacts": `file:${archive}`,
      },
    }, null, 2));
    await run([process.execPath, "install", "--ignore-scripts"], consumer, isolatedEnv);
    await run([process.execPath, "-e", `
      import { definePlugins } from "@sidequery/artifacts/plugins";
      import { pluginCall, artifactFiles } from "@sidequery/artifacts";
      import { runtimeIdentity } from "./node_modules/@sidequery/artifacts/src/history.ts";
      if (definePlugins([]).length !== 0 || typeof pluginCall !== "function") throw new Error("Plugin exports are missing");
      if (typeof artifactFiles.upload !== "function" || typeof artifactFiles.download !== "function") throw new Error("File exports are missing");
      const registry = "./node_modules/@sidequery/artifacts/dist/cloudflare/plugin-browser.json";
      const original = await Bun.file(registry).text();
      const before = runtimeIdentity();
      await Bun.write(registry, JSON.stringify({modules:{fixture:"export const value=1;"},files:{},paths:{}}));
      const after = runtimeIdentity();
      await Bun.write(registry, original);
      if (before === after) throw new Error("Plugin upgrades must invalidate cached local builds");
    `], consumer, isolatedEnv);


    const source = join(consumer, "package-smoke.artifact.tsx");
    await Bun.write(source, `import { Card, H1, Text } from "sidequery/artifacts";\nexport default function PackageSmoke() { return <Card><H1>Package smoke</H1><Text>Installed tarball</Text></Card>; }\n`);
    const artifact = join(consumer, "node_modules", ".bin", "artifacts");
    const args = ["--dir", artifacts, "--history-db", history];
    const written = JSON.parse((await run([artifact, "write", "package-smoke", "--file", source, ...args], consumer, isolatedEnv)).stdout);
    expect(written.ok).toBe(true);
    const checked = JSON.parse((await run([artifact, "typecheck", "package-smoke", ...args], consumer, isolatedEnv)).stdout);
    expect(checked.diagnostics).toEqual([]);
    const compiled = JSON.parse((await run([artifact, "compile", "package-smoke", ...args], consumer, isolatedEnv)).stdout);
    expect(compiled.ok).toBe(true);
    expect(compiled.bytes).toBeGreaterThan(1_000);

    gallery = Bun.spawn([artifact, "web", "--port", "0", ...args], {
      cwd: consumer,
      env: isolatedEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = await readyUrl(gallery);
    expect((await fetch(url)).status).toBe(200);
    const galleryData = await (await fetch(`${url}/api/gallery`)).json() as { artifacts: { name: string }[] };
    expect(galleryData.artifacts.some(artifact => artifact.name === "package-smoke")).toBe(true);
    gallery.kill("SIGTERM");
    expect(await gallery.exited).toBe(0);
    gallery = undefined;

    // Keep the official client in a sibling project, so dependency hoisting can
    // never hide a missing Artifact runtime dependency.
    await Bun.write(join(clientDirectory, "package.json"), JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
    }, null, 2));
    await run([process.execPath, "install", "--ignore-scripts"], clientDirectory, isolatedEnv);
    const mcpSmoke = join(clientDirectory, "mcp-smoke.ts");
    await Bun.write(mcpSmoke, `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "package-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: ${JSON.stringify(artifact)},
  args: ["mcp", "--dir", ${JSON.stringify(artifacts)}, "--history-db", ${JSON.stringify(history)}],
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === "artifact_read")) throw new Error("artifact_read tool missing");
  const result = await client.callTool({ name: "artifact_read", arguments: { name: "package-smoke" } });
  if (result.isError || !JSON.stringify(result.content).includes("Package smoke")) throw new Error("installed MCP read failed");
  const opened = await client.callTool({ name: "artifact_open", arguments: { name: "package-smoke" } });
  if (opened.isError || !opened._meta?.artifact) throw new Error("installed MCP preview failed");
} finally { await client.close(); }
`);
    await run([process.execPath, "run", mcpSmoke], clientDirectory, isolatedEnv);

    if (process.env.CELLD_PACKAGE_INTEGRATION === "1") {
      const target = process.platform === "darwin" && process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : process.platform === "linux" && process.arch === "arm64"
          ? "aarch64-unknown-linux-gnu"
          : process.platform === "linux" && process.arch === "x64"
            ? "x86_64-unknown-linux-gnu"
            : undefined;
      if (!target) throw new Error(`CELLD_PACKAGE_INTEGRATION is unsupported on ${process.platform}/${process.arch}`);
      if (process.env.CELLD_BIN) {
        const managedBinary = join(isolatedEnv.ARTIFACTS_DATA_HOME, "runtimes", "celld", "0.4.1", target, "celld");
        mkdirSync(dirname(managedBinary), { recursive: true });
        copyFileSync(process.env.CELLD_BIN, managedBinary);
        chmodSync(managedBinary, 0o700);
      }

      const httpSmoke = join(clientDirectory, "http-smoke.ts");
      await Bun.write(httpSmoke, `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [origin, mode] = process.argv.slice(2);
const client = new Client({ name: "native-package-smoke", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp")));
  if (mode === "write") {
    const written = await client.callTool({ name: "artifact_write", arguments: {
      name: "native-counter",
      contents: 'import { Text } from "sidequery/artifacts"; export default function Counter() { return <Text>Native counter</Text>; }',
      server: 'import { DurableObject } from "cloudflare:workers"; export class ArtifactServer extends DurableObject { fetch(request: Request): Response { this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key, value integer not null)"); this.ctx.storage.sql.exec("insert or ignore into counter values (1, 0)"); if (request.method === "POST") this.ctx.storage.sql.exec("update counter set value = value + 1 where id = 1"); return Response.json(this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one()); } }',
    } });
    if (written.isError) throw new Error("native artifact_write failed: " + JSON.stringify(written.content));
  }
  const result = await client.callTool({ name: "artifact_request", arguments: {
    name: "native-counter", request: { path: "/counter", method: mode === "write" ? "POST" : "GET", headers: [] },
  } });
  if (result.isError) throw new Error("native artifact_request failed: " + JSON.stringify(result.content));
  const response = result.structuredContent.response;
  if (response.status !== 200) throw new Error("native response status " + response.status);
  const files = async request => {
    const result = await client.callTool({ name: "artifact_files", arguments: { name: "native-counter", request } });
    if (result.isError) throw new Error("native artifact_files failed: " + JSON.stringify(result.content));
    return result.structuredContent.result;
  };
  const bytes = Buffer.alloc(1024 * 1024, 171);
  if (mode === "write") {
    const grant = await files({ operation: "upload", name: "package.bin", size: bytes.length, type: "application/octet-stream" });
    const uploaded = await fetch(grant.url, { method: "PUT", body: bytes });
    if (uploaded.status !== 201) throw new Error("installed file upload failed: " + await uploaded.text());
  }
  const listing = await files({ operation: "list" });
  if (listing.files.length !== 1) throw new Error("installed file listing did not persist");
  const grant = await files({ operation: "download", id: listing.files[0].id });
  const downloaded = Buffer.from(await (await fetch(grant.url)).arrayBuffer());
  if (!downloaded.equals(bytes)) throw new Error("installed file contents did not persist");
  console.log(Buffer.from(response.body, "base64").toString("utf8"));
} finally { await client.close(); }
`);
      const stateDir = join(temporary, "native-state");
      const firstPort = reservePort();
      const first = await startNativeServer(artifact, consumer, stateDir, firstPort, isolatedEnv);
      try {
        const locked = await execute([
          artifact, "server", "--port", String(reservePort()), "--state-dir", stateDir,
        ], consumer, isolatedEnv);
        expect(locked.code).not.toBe(0);
        expect(locked.stderr).toContain("already using");
        const incremented = JSON.parse((await run([
          process.execPath, "run", httpSmoke, first.url, "write",
        ], clientDirectory, isolatedEnv)).stdout);
        expect(incremented.value).toBe(1);
      } finally {
        await stopNativeServer(first);
      }

      const restarted = await startNativeServer(artifact, consumer, stateDir, reservePort(), isolatedEnv);
      try {
        const persisted = JSON.parse((await run([
          process.execPath, "run", httpSmoke, restarted.url, "read",
        ], clientDirectory, isolatedEnv)).stdout);
        expect(persisted.value).toBe(1);
      } finally {
        await stopNativeServer(restarted);
      }
    }
  } finally {
    if (gallery) { gallery.kill(); await gallery.exited; }
    rmSync(temporary, { recursive: true, force: true });
  }
}, { timeout: process.env.CELLD_PACKAGE_INTEGRATION === "1" ? 360_000 : 120_000 });
