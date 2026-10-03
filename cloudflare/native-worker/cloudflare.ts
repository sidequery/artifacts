import { createHash } from "node:crypto";
import { classAlias, resourceName, workerName, type NativeDeployment, type ProviderResult } from "./types";

export type CloudflareProviderState = {
  ids: Record<string, string>;
  migrations: Record<string, string[]>;
  gatewayToken: string;
  accountId?: string;
};
type Environment = { NATIVE_CF_ACCOUNT_ID?: string; NATIVE_CF_API_TOKEN?: string };
type Checkpoint = (stage: string, state: CloudflareProviderState) => Promise<void>;
type Pagination = { page?: number; per_page?: number; total_pages?: number; total_count?: number };
type ApiEnvelope<T> = { success: boolean; result: T; errors?: { code: number }[]; result_info?: Pagination };

const denyWorker = 'export default { fetch() { return new Response("Unavailable", {status:503}); } };';
export const gatewayWorker = `export default {
  async fetch(request, env) {
    const supplied = request.headers.get("x-artifacts-gateway-token") ?? "";
    const expected = env.APP_TOKEN;
    let difference = supplied.length ^ expected.length;
    for (let i = 0; i < expected.length; i++) difference |= (supplied.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
    if (difference) return new Response("Not found", {status:404});
    const target = request.headers.get("x-artifacts-target-url");
    if (!target && new URL(request.url).pathname === "/__artifacts_health") return Response.json({revision:env.APP_REVISION});
    if (!target || !/^https?:\\/\\//.test(target)) return new Response("Invalid target", {status:400});
    const headers = new Headers(request.headers);
    headers.delete("x-artifacts-gateway-token"); headers.delete("x-artifacts-target-url");
    return env.APP.fetch(new Request(target, {method:request.method,headers,body:request.body,redirect:"manual"}));
  }
};`;

/** Uses only controller-generated identities. No authored account IDs or API credentials enter a Worker. */
export class CloudflareNativeProvider {
  private readonly account: string;
  constructor(private readonly env: Environment, private readonly fetcher: typeof fetch = fetch) {
    if (!env.NATIVE_CF_ACCOUNT_ID || !/^[a-f0-9]{32}$/.test(env.NATIVE_CF_ACCOUNT_ID) || !env.NATIVE_CF_API_TOKEN) throw new Error("Cloudflare native provider is not configured");
    this.account = `/accounts/${env.NATIVE_CF_ACCOUNT_ID}`;
  }

  private async api<T>(path: string, method = "GET", body?: unknown, missing = false, pagination?: Pagination): Promise<T | null> {
    const form = body instanceof FormData;
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4${path.startsWith("/zones") ? "" : this.account}${path}`, {
      method, headers: { Authorization: `Bearer ${this.env.NATIVE_CF_API_TOKEN}`, ...(!form && body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Cloudflare API returned an unexpected redirect");
    if (missing && response.status === 404) return null;
    const envelope = await response.json() as ApiEnvelope<T>;
    if (!response.ok || !envelope.success) {
      // Upload diagnostics can contain authored data or secrets; never persist them in public status.
      throw new Error(`Cloudflare API ${method} ${path.split("?")[0]} failed (${response.status}; codes ${(envelope.errors ?? []).map(error => error.code).join(",")})`);
    }
    if (pagination) Object.assign(pagination, envelope.result_info);
    return envelope.result;
  }

  private async upload(name: string, code: string, metadata: Record<string, unknown>) {
    const body = new FormData();
    body.set("metadata", new Blob([JSON.stringify({ main_module: "worker.js", ...metadata })], { type: "application/json" }));
    body.set("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
    await this.api(`/workers/scripts/${name}`, "PUT", body);
  }

  private async privateIngress(name: string) {
    await this.api(`/workers/scripts/${name}/subdomain`, "POST", { enabled: false, previews_enabled: false });
    const result = await this.api<{ enabled: boolean; previews_enabled: boolean }>(`/workers/scripts/${name}/subdomain`);
    if (!result || result.enabled || result.previews_enabled) throw new Error("App public ingress could not be disabled");
    // Native app names are reserved for this controller. External routing changes fail closed.
    for (let page = 1; ; page++) {
      const zones = await this.api<{ id: string }[]>(`/zones?account.id=${this.env.NATIVE_CF_ACCOUNT_ID}&page=${page}&per_page=50`);
      if (!Array.isArray(zones)) throw new Error("Unable to verify account routes");
      for (const zone of zones) {
        const routes = await this.api<{ script: string }[]>(`/zones/${zone.id}/workers/routes`);
        if (routes?.some(route => route.script === name)) throw new Error("App has an external route; remove it before reconciling");
      }
      if (zones.length < 50) break;
      if (page >= 1000) throw new Error("Account zone listing limit reached");
    }
    const domains = await this.api<{ service: string }[]>(`/workers/domains?service=${name}`);
    if (domains?.some(domain => domain.service === name)) throw new Error("App has an external domain; remove it before reconciling");
  }

  private async resource(type: string, name: string): Promise<string> {
    if (type === "r2") {
      const existing = await this.api<{ name: string }>(`/r2/buckets/${name}`, "GET", undefined, true);
      if (!existing) await this.api("/r2/buckets", "POST", { name });
      return name;
    }
    const path = type === "kv" ? "/storage/kv/namespaces" : type === "d1" ? "/d1/database" : "/queues";
    const nameKey = type === "kv" ? "title" : type === "queue" ? "queue_name" : "name";
    const idKey = type === "d1" ? "uuid" : type === "queue" ? "queue_id" : "id";
    for (let page = 1; ; page++) {
      const pagination: Pagination = {};
      const query = type === "queue" ? `page=${page}&name=${encodeURIComponent(name)}` : `page=${page}&per_page=100`;
      const entries = await this.api<Record<string, string>[]>(`${path}?${query}`, "GET", undefined, false, pagination);
      if (!Array.isArray(entries)) throw new Error("Unexpected provider resource listing");
      const found = entries.filter(item => item[nameKey] === name);
      if (found.length > 1) throw new Error("Ambiguous app resource identity");
      if (found[0]) return found[0][idKey]!;
      if (pagination.page !== undefined && pagination.page !== page) throw new Error("Provider resource pagination did not advance");
      // Queues does not promise a requested page size. Use its returned metadata,
      // or continue until an empty page when metadata is absent.
      const complete = pagination.total_pages !== undefined ? page >= pagination.total_pages
        : pagination.per_page !== undefined && pagination.total_count !== undefined ? page * pagination.per_page >= pagination.total_count
        : type === "queue" ? entries.length === 0 : entries.length < 100;
      if (complete) break;
      if (page >= 1000) throw new Error("Provider resource listing limit reached");
    }
    const created = await this.api<Record<string, string>>(path, "POST", { [nameKey]: name });
    if (!created?.[idKey]) throw new Error("Provider did not return a resource identity");
    return created[idKey]!;
  }

  async reconcile(deployment: NativeDeployment, state: CloudflareProviderState, checkpoint: Checkpoint): Promise<ProviderResult> {
    if (state.accountId && state.accountId !== this.env.NATIVE_CF_ACCOUNT_ID) throw new Error("App provider account changed; restore its configured account before reconciling");
    state.accountId = this.env.NATIVE_CF_ACCOUNT_ID!;
    await checkpoint("provider-identity", state);
    const name = workerName(deployment.app), gateway = `${name}-gateway`;
    const script = await this.api<{ default_environment: { script: { migration_tag?: string } } }>(`/workers/services/${name}`, "GET", undefined, true);
    if (!script) {
      await checkpoint("prepare-private-worker", state);
      // A new script receives no authored code until public ingress is verified disabled.
      await this.upload(name, denyWorker, { compatibility_date: deployment.revision.manifest.compatibility_date, bindings: [] });
    }
    await checkpoint("verify-private-ingress", state);
    await this.privateIngress(name);
    for (const resource of Object.values(deployment.resources)) {
      if (resource.type === "durable-object") continue;
      if (!state.ids[resource.id]) {
        await checkpoint("provision-resources", state);
        state.ids[resource.id] = await this.resource(resource.type, resourceName(resource.id));
        await checkpoint("resources-observed", state);
      }
    }
    const classes = Object.values(deployment.resources).filter(item => item.type === "durable-object").map(item => classAlias(item.id)).sort();
    const tag = `app-${createHash("sha256").update(JSON.stringify(classes)).digest("hex").slice(0, 32)}`;
    const oldTag = script?.default_environment.script.migration_tag;
    const oldClasses = oldTag ? state.migrations[oldTag] : [];
    if (oldTag && !oldClasses) throw new Error("Provider migration state is unknown; operator recovery required");
    state.migrations[tag] = classes;
    await checkpoint("publish-worker", state);
    const bindings: Record<string, unknown>[] = Object.entries(deployment.revision.manifest.vars).map(([key, value]) => ({ type: "plain_text", name: key, text: value }));
    for (const [key, value] of Object.entries(deployment.secrets)) bindings.push({ type: "secret_text", name: key, text: value });
    for (const [key, binding] of Object.entries(deployment.revision.manifest.bindings)) {
      const resource = deployment.resources[binding.resource]!, id = state.ids[resource.id];
      bindings.push(binding.type === "durable-object" ? { type: "durable_object_namespace", name: key, class_name: classAlias(resource.id) }
        : binding.type === "kv" ? { type: "kv_namespace", name: key, namespace_id: id }
        : binding.type === "r2" ? { type: "r2_bucket", name: key, bucket_name: id }
        : binding.type === "d1" ? { type: "d1", name: key, id }
        : { type: "queue", name: key, queue_name: resourceName(resource.id) });
    }
    const migrations = oldTag === tag || classes.length === 0 ? undefined : {
      ...(oldTag ? { old_tag: oldTag } : {}), new_tag: tag,
      steps: [{ new_sqlite_classes: classes.filter(item => !oldClasses!.includes(item)) }],
    };
    await this.upload(name, deployment.revision.code, {
      compatibility_date: deployment.revision.manifest.compatibility_date, compatibility_flags: deployment.revision.manifest.compatibility_flags,
      bindings, ...(migrations ? { migrations } : {}), tags: [`artifacts-revision:${deployment.revision.id}`],
    });
    await this.privateIngress(name);
    await checkpoint("reconcile-triggers", state);
    await this.api(`/workers/scripts/${name}/schedules`, "PUT", deployment.revision.manifest.triggers.crons.map(cron => ({ cron })));
    for (const [resourceKey, resource] of Object.entries(deployment.resources)) {
      if (resource.type !== "queue") continue;
      const queueId = state.ids[resource.id]!;
      const consumers = await this.api<{ consumer_id: string; script_name?: string }[]>(`/queues/${queueId}/consumers`);
      if (!Array.isArray(consumers)) throw new Error("Unexpected queue consumer listing");
      if (consumers.some(consumer => consumer.script_name !== name)) throw new Error("App queue has a foreign consumer");
      const enabled = deployment.revision.manifest.triggers.queues.includes(resourceKey);
      const consumer = consumers[0];
      if (enabled) await this.api(`/queues/${queueId}/consumers${consumer ? "/" + consumer.consumer_id : ""}`, consumer ? "PUT" : "POST", { type: "worker", script_name: name, settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 1000 } });
      else for (const item of consumers) await this.api(`/queues/${queueId}/consumers/${item.consumer_id}`, "DELETE");
    }
    await checkpoint("publish-gateway", state);
    await this.upload(gateway, gatewayWorker, { compatibility_date: "2026-09-06", bindings: [
      { type: "service", name: "APP", service: name },
      { type: "secret_text", name: "APP_TOKEN", text: state.gatewayToken },
      { type: "plain_text", name: "APP_REVISION", text: deployment.revision.id },
    ] });
    await this.api(`/workers/scripts/${gateway}/subdomain`, "POST", { enabled: true, previews_enabled: false });
    const subdomain = await this.api<{ subdomain: string }>("/workers/subdomain");
    if (!subdomain?.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) throw new Error("Provider workers.dev subdomain unavailable");
    const endpoint = `https://${gateway}.${subdomain.subdomain}.workers.dev`;
    const response = await this.fetcher(`${endpoint}/__artifacts_health`, { headers: { "x-artifacts-gateway-token": state.gatewayToken }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Gateway revision is not ready; reconcile again");
    const health = await response.json() as { revision?: string };
    if (!response.ok || health.revision !== deployment.revision.id) throw new Error("Gateway revision is not ready; reconcile again");
    await checkpoint("gateway-ready", state);
    return { revision: deployment.revision.id, endpoint };
  }
}
