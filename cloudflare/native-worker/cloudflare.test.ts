import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { CloudflareNativeProvider, gatewayWorker, type CloudflareProviderState } from "./cloudflare";
import { appScope, parseManifest, planResources } from "./manifest";
import { classAlias, resourceName, workerName, type NativeDeployment } from "./types";

const app = "12345678-1234-4123-8123-123456789abc";
const manifest = parseManifest({ main: "worker.ts", compatibility_date: "2026-09-06", secrets: ["TOKEN"], bindings: {
  COUNTER: { type: "durable-object", resource: "counter", class_name: "Counter" },
  CACHE: { type: "kv", resource: "cache" }, FILES: { type: "r2", resource: "files" }, DB: { type: "d1", resource: "db" }, JOBS: { type: "queue", resource: "jobs" },
}, triggers: { crons: ["* * * * *"], queues: ["jobs"] } });
const resources = planResources(appScope(app, "native"), manifest, {});
const deployment: NativeDeployment = { app, resources, secrets: { TOKEN: "app-secret" }, revision: {
  id: "a".repeat(64), source: "source", code: "compiled-worker", manifest, created_at: new Date().toISOString(),
} };

class ApiFixture {
  readonly uploads: { name: string; code: string; metadata: Record<string, any> }[] = [];
  readonly calls: { method: string; path: string; body: any }[] = [];
  readonly existing: Record<string, Record<string, string>[]> = { kv: [], d1: [], queue: [] };
  readonly buckets = new Set<string>();
  readonly consumers: Record<string, any[]> = {};
  migrationTag?: string;
  exists = false;
  ambiguousKv = false;
  route = false;
  gatewayReady = true;
  fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.hostname.endsWith(".workers.dev")) {
      expect(new Headers(init?.headers).get("x-artifacts-gateway-token")).toBe("gateway-only-secret");
      return Response.json({ revision: this.gatewayReady ? this.uploads.at(-1)!.metadata.bindings.find((b: any) => b.name === "APP_REVISION").text : "stale" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-only-secret");
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[a-f0-9]{32}/, "").replace(/^\/client\/v4/, "");
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    if (path.startsWith("/workers/services/")) return this.exists ? ok({ default_environment: { script: { migration_tag: this.migrationTag } } }) : Response.json({ success: false }, { status: 404 });
    if (path.startsWith("/workers/scripts/") && path.endsWith("/subdomain")) return ok({ enabled: false, previews_enabled: false });
    if (path === "/zones") { expect(url.searchParams.get("account.id")).toBe("a".repeat(32)); return ok(this.route ? [{ id: "zone" }] : []); }
    if (path === "/zones/zone/workers/routes") return ok([{ script: workerName(app) }]);
    if (path === "/workers/domains") return ok([]);
    if (path === "/workers/subdomain") return ok({ subdomain: "fixture" });
    if (path.endsWith("/schedules")) return ok(body);
    if (method === "PUT" && path.startsWith("/workers/scripts/")) {
      const form = body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()), code = await (form.get("worker.js") as Blob).text();
      this.uploads.push({ name: path.split("/").at(-1)!, code, metadata });
      if (code !== gatewayWorker) { this.exists = true; if (metadata.migrations) this.migrationTag = metadata.migrations.new_tag; }
      return ok({ id: "uploaded" });
    }
    if (path.startsWith("/r2/buckets")) {
      if (method === "POST") { this.buckets.add(body.name); return ok(body); }
      const name = path.split("/").at(-1)!;
      return this.buckets.has(name) ? ok({ name }) : Response.json({ success: false }, { status: 404 });
    }
    if (path.includes("/consumers")) {
      const queue = path.split("/")[2]!;
      if (method === "GET") return ok(this.consumers[queue] ?? []);
      if (method === "DELETE") { this.consumers[queue] = []; return ok(null); }
      this.consumers[queue] = [{ consumer_id: "consumer", ...body }]; return ok(this.consumers[queue]![0]);
    }
    const type = path === "/storage/kv/namespaces" ? "kv" : path === "/d1/database" ? "d1" : path === "/queues" ? "queue" : undefined;
    if (!type) throw new Error(`Unexpected API ${method} ${path}`);
    if (method === "GET") {
      const page = Number(url.searchParams.get("page"));
      const perPage = type === "queue" ? 1 : 100;
      const entries = this.existing[type]!;
      return Response.json({ success: true, result: entries.slice((page - 1) * perPage, page * perPage), result_info: { page, per_page: perPage, total_pages: Math.ceil(entries.length / perPage), total_count: entries.length } });
    }
    const idKey = type === "queue" ? "queue_id" : type === "d1" ? "uuid" : "id";
    const result = { ...body, [idKey]: `resource-${type}` }; this.existing[type]!.push(result);
    if (type === "kv" && this.ambiguousKv) { this.ambiguousKv = false; throw new Error("Connection dropped after namespace creation"); }
    return ok(result);
  };
}
const state = (): CloudflareProviderState => ({ ids: {}, migrations: {}, gatewayToken: "gateway-only-secret" });
const provider = (fixture: ApiFixture) => new CloudflareNativeProvider({ NATIVE_CF_ACCOUNT_ID: "a".repeat(32), NATIVE_CF_API_TOKEN: "provider-only-secret" }, fixture.fetcher);

test("native Cloudflare upload preserves namespaces, reconciles queue/cron removal and separates gateway credentials", async () => {
  const fixture = new ApiFixture(), saved = state(), stages: string[] = [];
  const result = await provider(fixture).reconcile(deployment, saved, async stage => { stages.push(stage); });
  expect(result.revision).toBe(deployment.revision.id);
  expect(stages.at(-1)).toBe("gateway-ready");
  const uploaded = fixture.uploads.find(item => item.code === "compiled-worker")!;
  expect(uploaded.metadata.migrations.steps).toEqual([{ new_sqlite_classes: [classAlias(resources.counter!.id)] }]);
  expect(uploaded.metadata.bindings.find((b: any) => b.type === "durable_object_namespace").class_name).toBe(classAlias(resources.counter!.id));
  expect(JSON.stringify(uploaded.metadata)).not.toContain("provider-only-secret");
  expect(JSON.stringify(uploaded.metadata)).not.toContain("gateway-only-secret");
  expect(JSON.stringify(uploaded.metadata)).toContain("app-secret");
  const firstPublish = fixture.calls.findIndex(call => call.method === "PUT" && call.body instanceof FormData && call.path === `/workers/scripts/${workerName(app)}`);
  expect(fixture.uploads[0]!.code).toContain("Unavailable");
  expect(fixture.calls.slice(firstPublish + 1).some(call => call.path.endsWith("/subdomain") && call.body?.enabled === false)).toBe(true);
  const renamed = structuredClone(deployment);
  renamed.revision.manifest.bindings.COUNTER = { type: "durable-object", resource: "counter", class_name: "Renamed" };
  renamed.revision.manifest.triggers = { crons: [], queues: [] };
  await provider(fixture).reconcile(renamed, saved, async () => {});
  expect(fixture.uploads.filter(item => item.code === "compiled-worker").at(-1)!.metadata.migrations).toBeUndefined();
  expect(fixture.existing.kv).toHaveLength(1);
  expect(fixture.calls.some(call => call.method === "DELETE" && call.path.includes("/consumers/"))).toBe(true);
  expect(fixture.calls.filter(call => call.path.endsWith("/schedules")).at(-1)!.body).toEqual([]);
});

test("ambiguous resource creation is recovered by deterministic identity without creating a second namespace", async () => {
  const fixture = new ApiFixture(), saved = state(); fixture.ambiguousKv = true;
  await expect(provider(fixture).reconcile(deployment, saved, async () => {})).rejects.toThrow("Connection dropped");
  await provider(fixture).reconcile(deployment, saved, async () => {});
  expect(fixture.existing.kv).toHaveLength(1);
  expect(saved.ids[resources.cache!.id]).toBe("resource-kv");
});

test("foreign public routing and a stale gateway prevent activation", async () => {
  const fixture = new ApiFixture(); fixture.route = true;
  await expect(provider(fixture).reconcile(deployment, state(), async () => {})).rejects.toThrow("external route");
  expect(fixture.uploads.some(item => item.code === "compiled-worker")).toBe(false);
  fixture.route = false; fixture.gatewayReady = false;
  await expect(provider(fixture).reconcile(deployment, state(), async () => {})).rejects.toThrow("not ready");
});

test("queue reconciliation follows returned pagination and recovers a resource beyond the first page", async () => {
  const fixture = new ApiFixture(), saved = state();
  fixture.existing.queue = [{ queue_name: "unrelated", queue_id: "foreign" }, { queue_name: resourceName(resources.jobs!.id), queue_id: "retained" }];
  await provider(fixture).reconcile(deployment, saved, async () => {});
  expect(saved.ids[resources.jobs!.id]).toBe("retained");
  expect(fixture.existing.queue).toHaveLength(2);
  expect(fixture.calls.filter(call => call.path === "/queues" && call.method === "POST")).toHaveLength(0);
});

test("separate native gateway enforces its credential and strips transport headers while preserving request URL/body", async () => {
  const runtime = new Miniflare({ cf: false, port: 0, workers: [
    { config: {
      name: "app", type: "worker", compatibilityDate: "2026-09-06",
      manifest: { mainModule: "app.js", modules: { "app.js": { type: "esm", contents: 'export default { async fetch(request,env) { return Response.json({url:request.url,headers:Object.fromEntries(request.headers),body:await request.text(),bindings:Object.keys(env)}); } };' } } },
    }, dev: {} },
    { config: {
      name: "gateway", type: "worker", compatibilityDate: "2026-09-06",
      manifest: { mainModule: "gateway.js", modules: { "gateway.js": { type: "esm", contents: gatewayWorker } } },
      env: { APP: { type: "worker", worker: "app" }, APP_TOKEN: { type: "text", value: "gateway-only-secret" }, APP_REVISION: { type: "text", value: "revision" } },
    }, dev: {} },
  ] });
  try {
    await runtime.ready;
    const gateway = await runtime.getWorker("gateway");
    expect((await gateway.fetch("https://gateway.invalid/path")).status).toBe(404);
    const response = await gateway.fetch("https://gateway.invalid/path", { method: "POST", body: "payload", headers: { "x-artifacts-gateway-token": "gateway-only-secret", "x-artifacts-target-url": "https://artifacts.example/original?q=1", "x-user": "present" } });
    const value = await response.json() as { url: string; headers: Record<string, string>; body: string; bindings: string[] };
    expect(value.url).toBe("https://artifacts.example/original?q=1"); expect(value.body).toBe("payload"); expect(value.bindings).toEqual([]);
    expect(value.headers["x-user"]).toBe("present"); expect(value.headers["x-artifacts-gateway-token"]).toBeUndefined(); expect(value.headers["x-artifacts-target-url"]).toBeUndefined();
  } finally { await runtime.dispose(); }
});
