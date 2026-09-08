import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Browser } from "playwright";
import { prepareCelldConfig } from "../scripts/prepare-celld";

const root = resolve(import.meta.dir, "..");
const enabled = process.env.CELLD_INTEGRATION === "1";
const celldTest = enabled ? test : test.skip;
const binary = process.env.CELLD_BIN ?? Bun.which("celld");
const esbuild = process.env.CELLD_ESBUILD ?? resolve(root, "node_modules/.bin/esbuild");
const clientSource = await Bun.file(resolve(root, "examples/counter.canvas.tsx")).text();
const serverV1 = `
import { DurableObject } from "cloudflare:workers";
export class CanvasServer extends DurableObject {
  fetch(request: Request): Response {
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key, value integer not null)");
    this.ctx.storage.sql.exec("insert or ignore into counter values (1, 0)");
    if (request.method === "POST") this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("update counter set value = value + 1 where id = 1");
      const value = this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one().value;
      this.ctx.storage.kv.put("lastValue", value);
    });
    const value = this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one().value;
    return Response.json({ code: 1, value, kv: this.ctx.storage.kv.get("lastValue") ?? null });
  }
}`;
const serverV2 = serverV1.replace("code: 1", "code: 2");

let project = "";
let port = 0;
let baseUrl = "";
let processHandle: ReturnType<typeof Bun.spawn> | undefined;
let processLogs = "";
let browser: Browser | undefined;

function reservePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const selected = listener.port;
  listener.stop(true);
  return selected;
}

async function capture(stream: ReadableStream<Uint8Array> | number | undefined) {
  if (!(stream instanceof ReadableStream)) return;
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) return;
    processLogs += result.value;
  }
}

async function startCelld(compiler = esbuild) {
  if (!binary) throw new Error("celld was not found; install celld or set CELLD_BIN to its executable");
  processLogs = "";
  processHandle = Bun.spawn({
    cmd: [binary, "dev", project, "--host", "127.0.0.1", "--port", String(port), "--no-watch"],
    cwd: project,
    env: { ...process.env, CELLD_ESBUILD: compiler, CELLD_WORKER_LOADER: "LOADER" },
    stdout: "pipe",
    stderr: "pipe",
  });
  void capture(processHandle.stdout);
  void capture(processHandle.stderr);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await Promise.race([processHandle.exited.then(() => true), Bun.sleep(100).then(() => false)])) {
      throw new Error(`celld exited before readiness:\n${processLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
  }
  throw new Error(`celld did not become ready:\n${processLogs}`);
}

async function stopCelld() {
  const child = processHandle;
  processHandle = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function withClient<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ name: "canvas-celld-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return await run(client);
  } finally {
    await client.close();
  }
}

async function write(client: Client, server: string) {
  const result = await client.callTool({ name: "canvas_write", arguments: { name: "native-counter", contents: clientSource, server } });
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  return (result._meta as { canvas: { versionId: string } }).canvas.versionId;
}

async function request(client: Client, method: string) {
  const result = await client.callTool({ name: "canvas_request", arguments: {
    name: "native-counter", request: { path: "/counter", method, headers: [] },
  } });
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  const envelope = (result.structuredContent as { response: { status: number; body: string } }).response;
  expect(envelope.status).toBe(200);
  return JSON.parse(Buffer.from(envelope.body, "base64").toString("utf8")) as { code: number; value: number; kv: number };
}

beforeAll(async () => {
  if (!enabled) return;
  if (!binary) throw new Error("celld was not found; install celld or set CELLD_BIN to its executable");
  if (!existsSync(esbuild)) throw new Error(`esbuild was not found at ${esbuild}; run bun install or set CELLD_ESBUILD`);
  if (!existsSync(resolve(root, "dist/worker-app/worker.js"))) throw new Error("missing dist/worker-app/worker.js; run bun run build:cloudflare");
  project = await mkdtemp(join(tmpdir(), "canvas-celld-test-"));
  await cp(resolve(root, "dist/worker-app"), join(project, "dist/worker-app"), { recursive: true });
  await cp(resolve(root, "dist/cloudflare/assets"), join(project, "dist/cloudflare/assets"), { recursive: true });
  await prepareCelldConfig(resolve(root, "wrangler.jsonc"), join(project, "wrangler.jsonc"));
  port = reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await startCelld();
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await stopCelld();
  if (project) await rm(project, { recursive: true, force: true });
});

celldTest("runs native canvas SQLite and KV across code update and celld restart", async () => {
  await withClient(async client => {
    await write(client, serverV1);
    expect(await request(client, "POST")).toEqual({ code: 1, value: 1, kv: 1 });
    expect(await request(client, "POST")).toEqual({ code: 1, value: 2, kv: 2 });
    await write(client, serverV2);
    expect(await request(client, "GET")).toEqual({ code: 2, value: 2, kv: 2 });
  });

  const gallery = await fetch(`${baseUrl}/api/gallery`);
  expect(gallery.status).toBe(200);
  expect(await gallery.text()).toContain("native-counter");
  const preview = await fetch(`${baseUrl}/gallery/preview?name=native-counter`);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toContain("serverVersionId");

  if (!existsSync(chromium.executablePath())) {
    throw new Error("Chromium is not installed; run bun x playwright install chromium");
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "native-counter", exact: true }).waitFor();
  const frame = page.frameLocator("iframe.preview-frame");
  await frame.getByText("Count: 2", { exact: true }).waitFor({ timeout: 30_000 });
  await frame.getByRole("button", { name: "Increment" }).click();
  await frame.getByText("Count: 3", { exact: true }).waitFor({ timeout: 30_000 });
  await browser.close();
  browser = undefined;

  await stopCelld();
  await startCelld();
  await withClient(async client => {
    expect(await request(client, "GET")).toEqual({ code: 2, value: 3, kv: 3 });
  });
});

celldTest("aborted archived previews do not block reads or subsequent edits", async () => {
  const version = await withClient(client => write(client, serverV1));
  await withClient(client => write(client, serverV2));
  const url = `${baseUrl}/gallery/preview?version=${version}`;
  // Previews retrieve saved bundles; disconnects must not interfere with
  // archived reads or the request-owned compiler used by later edits.
  for (const delay of [10, 25, 50]) {
    // Alternate current backend execution and the archived client/server pair.
    await withClient(client => request(client, "GET"));
    const controller = new AbortController();
    const interrupted = fetch(url, { signal: controller.signal })
      .then(response => response.text()).catch(error => {
        if (!controller.signal.aborted) throw error;
      });
    await Bun.sleep(delay);
    controller.abort();
    await interrupted;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(error => {
      throw new Error(`Preview after ${delay}ms disconnect: ${String(error)}\n${processLogs}`);
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("serverVersionId");
  }
  await withClient(client => write(client, serverV2.replace("code: 2", "code: 3")));
  await withClient(async client => {
    expect(await request(client, "GET")).toMatchObject({ code: 3 });
  });
}, 45_000);

celldTest("saved canvas bundles serve after restart with native compilation disabled", async () => {
  const marker = join(project, "compiler-disabled");
  const wrapper = join(project, "guarded-esbuild");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nif [ -e ${quote(marker)} ]; then\n  echo 'Unexpected compilation during artifact read' >&2\n  exit 1\nfi\nexec ${quote(esbuild)} "$@"\n`);
  await chmod(wrapper, 0o700);
  await stopCelld();
  await startCelld(wrapper);
  try {
    const version = await withClient(async client => {
      const version = await write(client, serverV1);
      const link = await client.callTool({ name: "artifact_link", arguments: { kind: "canvas", name: "native-counter", slug: "compiled-counter", access: "private" } });
      expect(link.isError).not.toBe(true);
      return version;
    });
    for (const restart of [false, true]) {
      if (restart) {
        await stopCelld();
        await rm(marker, { force: true });
        // Startup packages the application once. Subsequent artifact reads
        // must not invoke esbuild, even in the new process's first request.
        await startCelld(wrapper);
      }
      await writeFile(marker, "disabled");
      for (const path of [`/gallery/preview?version=${version}`, "/compiled-counter", "/compiled-counter/details"]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("serverVersionId");
      }
      await withClient(async client => {
        const preview = await client.callTool({ name: "canvas_open", arguments: { version_id: version } });
        expect(preview.isError).not.toBe(true);
        expect(await request(client, "GET")).toMatchObject({ code: 1 });
      });
    }
  } finally { await rm(marker, { force: true }); }
}, 180_000);
