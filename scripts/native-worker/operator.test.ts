import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classAlias, resourceName, type NativeDeployment } from "../../cloudflare/native-worker/types";
import { parseManifest, planResources } from "../../cloudflare/native-worker/manifest";
import { CelldOperator, validateDeployment } from "./operator";
import { ensureCelldRuntime } from "../../src/local/celld-runtime";

const token = "operator-only-test-token-with-at-least-32-characters";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function deployment(app: string = randomUUID(), greeting = "first"): NativeDeployment {
  const manifest = parseManifest({
    main: "worker.js", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
    vars: { GREETING: greeting }, secrets: ["APP_SECRET"],
    bindings: {
      COUNTERS: { type: "durable-object", resource: "counter", class_name: "Counter" },
      CACHE: { type: "kv", resource: "cache" }, FILES: { type: "r2", resource: "files" },
      DB: { type: "d1", resource: "database" }, JOBS: { type: "queue", resource: "jobs" },
    }, triggers: { queues: ["jobs"] },
  });
  const resources = planResources(app, manifest, {});
  const source = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  increment() {
    this.ctx.storage.sql.exec("create table if not exists visits(n integer)");
    this.ctx.storage.sql.exec("insert into visits values(1)");
    return this.ctx.storage.sql.exec("select count(*) as n from visits").one().n;
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/request-info")) return Response.json({ origin: url.origin, pathname: url.pathname, search: url.search, headers: Object.fromEntries(request.headers) });
    if (url.pathname === "/headers") return Response.json({ headers: Object.fromEntries(request.headers), bindings: Object.keys(env).sort(), secret: env.APP_SECRET, operatorToken: process.env.NATIVE_WORKER_OPERATOR_TOKEN ?? null });
    if (url.pathname === "/echo") return new Response(request.body);
    if (url.pathname === "/queue") { await env.JOBS.send("hello"); return new Response("queued"); }
    if (url.pathname === "/events") return Response.json(await env.CACHE.get("events", "json"));
    const count = await env.COUNTERS.get(env.COUNTERS.idFromName("one")).increment();
    await env.CACHE.put("count", String(count));
    await env.FILES.put("count", String(count));
    await env.DB.prepare("create table if not exists visits(n integer)").run();
    await env.DB.prepare("insert into visits values(?)").bind(count).run();
    return Response.json({ greeting: env.GREETING, count, cached: await env.CACHE.get("count"), file: await (await env.FILES.get("count")).text(), rows: await env.DB.prepare("select count(*) as n from visits").first("n") });
  },
  async queue(batch, env) { await env.CACHE.put("events", JSON.stringify({queue: batch.queue, bodies: batch.messages.map(m => m.body)})); batch.ackAll(); }
};`;
  const code = `${source}\nexport { Counter as ${classAlias(resources.counter!.id)} };`;
  return { app, revision: { id: hash(JSON.stringify({ source, manifest, code })), source, manifest, code, created_at: new Date().toISOString() }, resources, secrets: { APP_SECRET: "app-only-secret\nwith literal $value" } };
}

test("operator rejects invalid deployment identities and undeclared secrets", () => {
  const input = deployment();
  expect(validateDeployment(input).resources).toEqual(input.resources);
  expect(() => validateDeployment({ ...input, app: "../../other" })).toThrow("app UUID");
  expect(() => validateDeployment({ ...input, revision: { ...input.revision, id: "../revision" } })).toThrow("revision ID");
  expect(() => validateDeployment({ ...input, resources: { ...input.resources, cache: { type: "kv", id: "other-account" } } })).toThrow("resource identity");
  expect(() => validateDeployment({ ...input, secrets: { ...input.secrets, HOST_TOKEN: token } })).toThrow("app secret");
  expect(() => validateDeployment({ ...input, secrets: {} })).toThrow("Missing declared secret");
  expect(() => validateDeployment({ ...input, revision: { ...input.revision, manifest: { ...input.revision.manifest, services: [{ service: "host" }] } } })).toThrow("manifest");
});

test("operator requires authentication before parsing input or proxying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-auth-"));
  const operator = new CelldOperator({ root: directory, token });
  try {
    expect((await operator.fetch(new Request("http://operator/deploy", { method: "POST", body: "not json" }))).status).toBe(401);
    expect((await operator.fetch(new Request(`http://operator/apps/${randomUUID()}/`, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const response = await operator.fetch(new Request("http://operator/deploy", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "not json" }));
    expect(response.status).toBe(400);
    expect(await response.json() as Record<string, unknown>).toEqual({ error: "Invalid JSON" });
    expect((await readdir(directory)).length).toBe(0);
  } finally { await operator.close(); await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("startup crash releases ownership before runtime initialization without admitting a live contender", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-startup-"));
  const marker = join(directory, "initializing.pid");
  const gate = join(directory, "version-gate");
  // Reproduce the ownerless directory left by the previous startup protocol.
  await mkdir(join(directory, "operator.lock"));
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  await writeFile(gate, `#!/bin/sh\nprintf '%s' "$$" > ${quotedMarker}\nexec /bin/sleep 60\n`, { mode: 0o700 });
  const interrupted = Bun.spawn([process.execPath, join(import.meta.dir, "operator.ts")], {
    env: { ...process.env, NATIVE_WORKER_OPERATOR_TOKEN: token, NATIVE_WORKER_OPERATOR_ROOT: directory, CELLD_BIN: gate },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const options = { root: directory, token, binary: process.env.CELLD_BIN };
  const contender = new CelldOperator(options);
  let gatePid: number | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!await Bun.file(marker).exists() && interrupted.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(marker).exists()).toBe(true);
    gatePid = Number(await readFile(marker, "utf8"));
    await expect(contender.start()).rejects.toThrow("locked");
    interrupted.kill("SIGKILL");
    await interrupted.exited;
    process.kill(gatePid, "SIGTERM");
    gatePid = undefined;
    await contender.start();
    const response = await contender.fetch(new Request("http://operator/health", { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    expect((await stat(join(directory, "operator-lock.sqlite"))).mode & 0o777).toBe(0o600);
  } finally {
    if (interrupted.exitCode === null) { interrupted.kill("SIGKILL"); await interrupted.exited; }
    if (gatePid !== undefined) { try { process.kill(gatePid, "SIGTERM"); } catch {} }
    await contender.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("celld operator deploys native resources, retains state on update/restart, and recovers a failed update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-celld-"));
  const options = { root: directory, token, binary: process.env.CELLD_BIN, startupTimeoutMs: 30_000 };
  let operator = new CelldOperator(options);
  try {
    await operator.start();
    const duplicate = new CelldOperator(options);
    await expect(duplicate.start()).rejects.toThrow("locked");
    const server = operator.serve({ port: 0 });
    const first = deployment();
    const deployResponse = await fetch(new URL("/deploy", server.url), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(first) });
    expect(deployResponse.status, await deployResponse.clone().text()).toBe(200);
    const result = await deployResponse.json() as { revision: string; endpoint: string };
    expect(result).toEqual({ revision: first.revision.id, endpoint: `${server.url.origin}/apps/${first.app}/` });
    const call = (path = "", init?: RequestInit) => fetch(`${result.endpoint}${path}`, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
    expect(await (await call()).json() as Record<string, unknown>).toEqual({ greeting: "first", count: 1, cached: "1", file: "1", rows: 1 });
    const inspected = await (await call("headers", { headers: { cookie: "private-link=secret", "x-forwarded-host": "forged", "x-request-id": "retained" } })).json() as any;
    expect(inspected.headers.authorization).toBeUndefined();
    expect(inspected.headers.cookie).toBeUndefined();
    expect(inspected.headers["x-forwarded-host"]).toBeUndefined();
    expect(inspected.headers["x-request-id"]).toBe("retained");
    expect(inspected.secret).toBe(first.secrets.APP_SECRET);
    expect(inspected.operatorToken).toBeNull();
    expect(inspected.bindings).toEqual(["APP_SECRET", "CACHE", "COUNTERS", "DB", "FILES", "GREETING", "JOBS"]);
    const routed = await (await call("request-info", { headers: {
      "x-artifacts-target-url": "https://private.example:9443/api/nested/request-info?value=two%20words&x=1",
      "x-artifacts-gateway-token": "provider-secret", "x-artifacts-app-selection": "private-selector",
      "cf-access-jwt-assertion": "private-jwt", "cf-access-client-id": "private-id", "cf-access-client-secret": "private-secret",
    } })).json() as any;
    expect(routed.origin).toBe("https://private.example:9443");
    expect(routed.pathname).toBe("/api/nested/request-info");
    expect(routed.search).toBe("?value=two%20words&x=1");
    expect(routed.headers.host).toBe("private.example:9443");
    for (const name of ["authorization", "x-artifacts-target-url", "x-artifacts-gateway-token", "x-artifacts-app-selection", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) expect(routed.headers[name]).toBeUndefined();
    expect((await call("request-info", { headers: { "x-artifacts-target-url": "file:///etc/passwd" } })).status).toBe(400);
    expect(await (await call("echo", { method: "POST", body: "streamed-body" })).text()).toBe("streamed-body");
    expect(await (await call("queue")).text()).toBe("queued");
    let events: any;
    const queueDeadline = Date.now() + 10_000;
    do { events = await (await call("events")).json(); if (events) break; await Bun.sleep(100); } while (Date.now() < queueDeadline);
    expect(events).toEqual({ queue: resourceName(first.resources.jobs!.id), bodies: ["hello"] });

    const second = deployment(first.app, "second");
    // Renaming the authored class retains the generated physical namespace.
    const counterBinding = second.revision.manifest.bindings.COUNTERS!;
    if (counterBinding.type !== "durable-object") throw new Error("Fixture requires a Durable Object");
    counterBinding.class_name = "RenamedCounter";
    second.revision.code = second.revision.code.replaceAll("Counter", "RenamedCounter");
    second.revision.source = second.revision.source.replaceAll("Counter", "RenamedCounter");
    second.revision.id = hash(JSON.stringify(second.revision));
    await operator.deploy(second, server.url.origin);
    expect(await (await call()).json() as Record<string, unknown>).toEqual({ greeting: "second", count: 2, cached: "2", file: "2", rows: 2 });
    expect((await call("", { headers: { upgrade: "websocket" } })).status).toBe(501);
    const pidFile = join(directory, "apps", first.app, "runtime.pid");
    const exitedPid = Number(await readFile(pidFile, "utf8"));
    process.kill(exitedPid, "SIGTERM");
    const restartDeadline = Date.now() + 15_000;
    let recovered = false;
    do {
      await Bun.sleep(100);
      try { recovered = Number(await readFile(pidFile, "utf8")) !== exitedPid && (await call("headers")).ok; } catch {}
    } while (!recovered && Date.now() < restartDeadline);
    expect(recovered).toBe(true);
    const invalid = structuredClone(second);
    invalid.revision.id = hash("invalid update");
    invalid.revision.code = "this is not valid javascript";
    await expect(operator.deploy(invalid, server.url.origin)).rejects.toThrow("ready");
    expect(await (await call()).json() as Record<string, unknown>).toEqual({ greeting: "second", count: 3, cached: "3", file: "3", rows: 3 });
    const failed = JSON.parse(await readFile(join(directory, "apps", first.app, "deployment.json"), "utf8"));
    expect(failed.desired.revision.id).toBe(invalid.revision.id);
    expect(failed.active.revision.id).toBe(second.revision.id);
    await operator.deploy(second, server.url.origin);
    const alteredResource = structuredClone(second);
    alteredResource.resources.counter!.id = hash("different counter");
    await expect(operator.deploy(alteredResource, server.url.origin)).rejects.toThrow("cannot change");
    const conflictingRevision = structuredClone(second);
    conflictingRevision.revision.code += "\n// changed";
    await expect(operator.deploy(conflictingRevision, server.url.origin)).rejects.toThrow("immutable");

    const appDir = join(directory, "apps", first.app);
    const revisionText = await readFile(join(appDir, "revisions", `${second.revision.id}.json`), "utf8");
    const journalText = await readFile(join(appDir, "deployment.json"), "utf8");
    expect(revisionText).not.toContain("app-only-secret");
    expect(journalText).not.toContain("app-only-secret");
    const secretFiles = await readdir(join(appDir, "secrets"));
    expect(secretFiles.length).toBe(1);
    expect((await stat(join(appDir, "secrets", secretFiles[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(join(appDir, "project", "wrangler.jsonc"))).mode & 0o777).toBe(0o600);
    await operator.close();
    operator = new CelldOperator(options);
    await operator.start();
    const restarted = operator.serve({ port: 0 });
    const response = await fetch(`${restarted.url.origin}/apps/${first.app}/`, { headers: { authorization: `Bearer ${token}` } });
    expect(await response.json() as Record<string, unknown>).toEqual({ greeting: "second", count: 4, cached: "4", file: "4", rows: 4 });
  } finally { await operator.close(); await rm(directory, { recursive: true, force: true }); }
}, 180_000);

for (const failedStarts of [1, 3]) test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")(`automatic recovery retries ${failedStarts} failed startups within its budget and preserves storage`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-retries-"));
  const binary = process.env.CELLD_BIN ?? await ensureCelldRuntime({ dataRoot: join(directory, "runtime") });
  const wrapper = join(directory, "celld-launcher");
  const failures = join(directory, "remaining-failures");
  const launches = join(directory, "launches");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(failures, "0");
  await writeFile(launches, "");
  // Fail actual dev startups before readiness, while passing through version
  // checks and successful launches to the real celld binary.
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = dev ]; then
  printf 'launch\\n' >> ${quote(launches)}
  remaining=$(cat ${quote(failures)})
  if [ "$remaining" -gt 0 ]; then
    printf '%s' "$((remaining - 1))" > ${quote(failures)}
    exit 1
  fi
fi
exec ${quote(binary)} "$@"
`, { mode: 0o700 });
  const operator = new CelldOperator({ root: join(directory, "operator"), token, binary: wrapper });
  try {
    await operator.start();
    const server = operator.serve({ port: 0 });
    const input = deployment();
    const result = await operator.deploy(input, server.url.origin);
    const call = (path = "") => fetch(result.endpoint + path, { headers: { authorization: `Bearer ${token}` } });
    expect((await (await call()).json() as any).count).toBe(1);
    await writeFile(failures, String(failedStarts));
    const pid = Number(await readFile(join(directory, "operator", "apps", input.app, "runtime.pid"), "utf8"));
    process.kill(pid, "SIGTERM");
    const launchCount = async () => (await readFile(launches, "utf8")).trim().split("\n").length;
    const expectedLaunches = failedStarts === 1 ? 3 : 4;
    const deadline = Date.now() + 20_000;
    let response: Response | undefined;
    do {
      await Bun.sleep(100);
      response = await call("headers");
      if (await launchCount() === expectedLaunches && (failedStarts === 3 || response.ok)) break;
      await response.body?.cancel();
    } while (Date.now() < deadline);
    expect(await launchCount()).toBe(expectedLaunches);
    if (failedStarts === 1) {
      expect(response!.status).toBe(200);
      await response!.body?.cancel();
      expect((await (await call()).json() as any).count).toBe(2);
    } else {
      await response?.body?.cancel();
      // Allow enough time for an erroneous fourth retry to run.
      await Bun.sleep(4500);
      expect(await launchCount()).toBe(4);
      expect((await call()).status).toBe(503);
      await operator.deploy(input, server.url.origin);
      expect((await (await call()).json() as any).count).toBe(2);
      expect(await launchCount()).toBe(5);
    }
  } finally { await operator.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("routing preserves WorkerEntrypoint class fetch context and native queue handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-entrypoint-"));
  const operator = new CelldOperator({ root: directory, token, binary: process.env.CELLD_BIN });
  try {
    await operator.start();
    const server = operator.serve({ port: 0 });
    const input = deployment();
    input.revision.source = `import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {}
export default class App extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/queue") { await this.env.JOBS.send("class-message"); return new Response("queued"); }
    if (url.pathname === "/events") return Response.json(await this.env.CACHE.get("events", "json"));
    return Response.json({ origin: url.origin, path: url.pathname, search: url.search, target: request.headers.get("x-artifacts-target-url"), greeting: this.env.GREETING });
  }
  async queue(batch) { await this.env.CACHE.put("events", JSON.stringify(batch.messages.map(message => message.body))); batch.ackAll(); }
  async scheduled() { await this.env.CACHE.put("scheduled", "class-event"); }
}`;
    input.revision.code = `${input.revision.source}\nexport { Counter as ${classAlias(input.resources.counter!.id)} };`;
    input.revision.id = hash(input.revision.code);
    const result = await operator.deploy(input, server.url.origin);
    const call = (path: string, target?: string) => fetch(`${result.endpoint}${path}`, { headers: { authorization: `Bearer ${token}`, ...(target ? { "x-artifacts-target-url": target } : {}) } });
    expect(await (await call("inspect", "https://class.example/deep/path?a=1")).json() as any).toEqual({ origin: "https://class.example", path: "/deep/path", search: "?a=1", target: null, greeting: "first" });
    expect(await (await call("queue")).text()).toBe("queued");
    let events: unknown;
    const deadline = Date.now() + 10_000;
    do { events = await (await call("events")).json(); if (events) break; await Bun.sleep(100); } while (Date.now() < deadline);
    expect(events).toEqual(["class-message"]);
  } finally { await operator.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("operator process crash recovers its orphan runtime before reopening retained storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-operator-crash-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const origin = `http://127.0.0.1:${listener.port}`;
  listener.stop(true);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let logs = "";
  const spawn = () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "operator.ts")], {
      env: { ...process.env, NATIVE_WORKER_OPERATOR_TOKEN: token, NATIVE_WORKER_OPERATOR_ROOT: directory, NATIVE_WORKER_OPERATOR_PORT: new URL(origin).port },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) if (stream && typeof stream !== "number") void (async () => { for await (const chunk of stream) logs = (logs + new TextDecoder().decode(chunk)).slice(-8192); })();
    return child;
  };
  const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });
  const ready = async (child: ReturnType<typeof Bun.spawn>) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { if ((await request("/health")).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Operator process did not start");
  };
  try {
    const first = spawn();
    await ready(first);
    const input = deployment();
    expect((await request("/deploy", { method: "POST", body: JSON.stringify(input) })).status).toBe(200);
    expect((await (await request(`/apps/${input.app}/`)).json() as any).count).toBe(1);
    const previousPid = Number(await readFile(join(directory, "apps", input.app, "runtime.pid"), "utf8"));
    first.kill("SIGKILL");
    await first.exited;
    const second = spawn();
    await ready(second);
    expect(Number(await readFile(join(directory, "apps", input.app, "runtime.pid"), "utf8")), logs).not.toBe(previousPid);
    expect((await (await request(`/apps/${input.app}/`)).json() as any).count).toBe(2);
  } finally {
    for (const child of children) if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
