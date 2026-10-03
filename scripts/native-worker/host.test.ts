import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject, NativeWorkerHost } from "./host";
import { parseManifest, type AppManifest } from "./manifest";

let directory: string;
let project: Awaited<ReturnType<typeof loadProject>>;
const hosts: NativeWorkerHost[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "native-worker-apps-"));
  project = await loadProject(join(import.meta.dir, "../../examples/native-worker/app.json"));
});
afterAll(async () => { for (const host of hosts) await host.dispose(); await rm(directory, { recursive: true, force: true }); });
function host(owner: string, app: string) {
  const instance = new NativeWorkerHost(directory, owner, app);
  hosts.push(instance);
  return instance;
}
async function json(instance: NativeWorkerHost, path = "/") {
  const response = await instance.fetch(path);
  expect(response.status).toBe(200);
  return response.json();
}

test("unchanged Worker uses native DO HTTP/RPC, KV, R2, D1, streams, scheduled and queued events", async () => {
  const instance = host("alice", "app");
  const deployment = await instance.deploy(project.manifest, project.code, { API_TOKEN: "app-secret" });
  const expectedBindings = ["API_TOKEN", "CACHE", "COUNTERS", "DB", "FILES", "GREETING", "JOBS"];
  expect(await json(instance)).toEqual({ greeting: "native Worker", count: 1, cached: "1", file: "1", visits: 1, hasToken: true, bindings: expectedBindings });
  expect(await json(instance, "/rpc")).toMatchObject({ count: 2, visits: 2 });
  expect(await json(instance, "/?name=second")).toMatchObject({ count: 1, visits: 3 });
  const bytes = new Uint8Array(512 * 1024).fill(42);
  const stream = await instance.fetch("/stream", { method: "POST", body: bytes });
  expect(new Uint8Array(await stream.arrayBuffer())).toEqual(bytes);
  await instance.scheduled("0 * * * *", 123456);
  expect(await json(instance, "/events")).toMatchObject({ scheduled: { cron: "0 * * * *", time: 123456 } });
  await expect(instance.scheduled("* * * * *")).rejects.toThrow("Undeclared cron");
  expect(await (await instance.fetch("/queue")).text()).toBe("queued");
  // Observe actual producer -> broker -> queue handler delivery, not a mocked batch.
  const deadline = Date.now() + 10_000;
  let events: any;
  do { events = await json(instance, "/events"); if (events.queued) break; await Bun.sleep(50); } while (Date.now() < deadline);
  expect(events.queued).toEqual({ queue: deployment.resources.jobs!.id, bodies: [{ message: "from fetch" }] });
  const stored = await readFile(join(directory, instance.scope, "deployment.json"), "utf8");
  expect(stored).not.toContain("app-secret");
}, 30_000);

test("identical apps have isolated storage and secrets; updates and restart retain all resources", async () => {
  const alice = host("alice", "upgrade");
  const bob = host("bob", "upgrade");
  const first = await alice.deploy(project.manifest, project.code, { API_TOKEN: "alice-secret" });
  const other = await bob.deploy(project.manifest, project.code, { API_TOKEN: "bob-secret" });
  expect(first.resources.counters!.id).not.toBe(other.resources.counters!.id);
  expect(await json(alice)).toMatchObject({ count: 1, visits: 1 });
  expect(await json(bob)).toMatchObject({ count: 1, visits: 1 });
  expect(await (await alice.fetch("/token-check", { headers: { "x-token": "alice-secret" } })).json()).toEqual({ matches: true });
  expect(await (await bob.fetch("/token-check", { headers: { "x-token": "alice-secret" } })).json()).toEqual({ matches: false });
  const second = await alice.deploy({ ...project.manifest, vars: { GREETING: "updated" } }, project.code, { API_TOKEN: "rotated" });
  expect(second.resources).toEqual(first.resources);
  expect(await json(alice)).toMatchObject({ greeting: "updated", count: 2, visits: 2 });
  expect(await (await alice.fetch("/token-check", { headers: { "x-token": "rotated" } })).json()).toEqual({ matches: true });
  await alice.restore(first.revision, { API_TOKEN: "current-secret" });
  expect(await json(alice)).toMatchObject({ greeting: "native Worker", count: 3, visits: 3 });
  expect(await json(bob)).toMatchObject({ count: 2, visits: 2 });
  await alice.dispose();
  const restarted = host("alice", "upgrade");
  await restarted.restore(second.revision, { API_TOKEN: "restart-secret" });
  expect(await json(restarted, "/storage")).toEqual({ cached: "3", file: "3", visits: 3 });
  expect(await (await restarted.fetch("/token-check", { headers: { "x-token": "restart-secret" } })).json()).toEqual({ matches: true });
  expect(await json(restarted)).toMatchObject({ greeting: "updated", count: 4, visits: 4 });
}, 30_000);

test("DO class rename retains namespace identity; resource removal and restoration retain data", async () => {
  const instance = host("alice", "migrations");
  const first = await instance.deploy(project.manifest, project.code, { API_TOKEN: "secret" });
  expect(await json(instance)).toMatchObject({ count: 1, visits: 1 });
  const renamed = structuredClone(project.manifest);
  const counters = renamed.bindings.COUNTERS!;
  if (counters.type !== "durable-object") throw new Error("Expected DO fixture");
  counters.class_name = "RenamedCounter";
  // Bun's output has both the internal class and the public export name.
  const renamedCode = project.code.replace(/\bCounter\b/g, "RenamedCounter");
  const next = await instance.deploy(renamed, renamedCode, { API_TOKEN: "secret" });
  expect(next.resources).toEqual(first.resources);
  expect(await json(instance)).toMatchObject({ count: 2, visits: 2 });
  const removed: AppManifest = { ...project.manifest, bindings: {}, secrets: [], triggers: { crons: [], queues: [] } };
  await instance.deploy(removed, "export default { fetch(request, env) { return Response.json(Object.keys(env)); } };");
  expect(await json(instance)).toEqual(["GREETING"]);
  await instance.restore(first.revision, { API_TOKEN: "current" });
  expect(await json(instance, "/storage")).toEqual({ cached: "2", file: "2", visits: 2 });
  expect(await json(instance)).toMatchObject({ count: 3, visits: 3 });
  await expect(instance.deploy({ ...removed, bindings: { BAD: { type: "kv", resource: "counters" } } }, project.code)).rejects.toThrow("cannot change type");
  expect(await json(instance)).toMatchObject({ count: 4 });
}, 30_000);

test("invalid updates and undeclared capabilities fail without replacing the active app", async () => {
  const instance = host("alice", "validation");
  const first = await instance.deploy(project.manifest, project.code, { API_TOKEN: "secret" });
  expect(() => parseManifest({ ...project.manifest, services: [{ binding: "HOST", service: "host" }] })).toThrow("Unsupported manifest");
  expect(() => parseManifest({ ...project.manifest, bindings: { HOST: { type: "kv", resource: "host", id: "other-tenant" } } })).toThrow("Unsupported binding");
  await expect(instance.deploy(project.manifest, project.code, { API_TOKEN: "secret", HOST_TOKEN: "host" })).rejects.toThrow("Undeclared secret");
  await expect(instance.deploy(project.manifest, project.code)).rejects.toThrow("Missing declared secret");
  await expect(instance.deploy(project.manifest, "throw new Error('bad module'); export default {};", { API_TOKEN: "secret" })).rejects.toThrow();
  expect(await json(instance)).toMatchObject({ count: 1, visits: 1 });
  const state = JSON.parse(await readFile(join(directory, instance.scope, "deployment.json"), "utf8"));
  expect(state.active).toBe(first.revision);
}, 30_000);
