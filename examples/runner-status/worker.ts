import { boundedSnapshot, emptyCache, githubList, readConfig, refresh, refreshSeconds, type Cache } from "./collector";

export type Env = { RUNNER_STATUS: DurableObjectNamespace; GITHUB_TOKEN: string; RUNNER_STATUS_TOKEN: string; RUNNER_ORG: string; RUNNER_REPOS: string; RUNNER_NAME_PREFIX?: string };
const headers = { "cache-control": "no-store", "content-type": "application/json", "x-content-type-options": "nosniff" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.RUNNER_STATUS_TOKEN || request.headers.get("authorization") !== `Bearer ${env.RUNNER_STATUS_TOKEN}`) return new Response('{"error":"Unauthorized"}', { status: 401, headers });
    if (new URL(request.url).pathname !== "/api/status") return new Response('{"error":"Not found"}', { status: 404, headers });
    if (request.method !== "GET") return new Response('{"error":"Read only"}', { status: 405, headers: { ...headers, allow: "GET" } });
    return env.RUNNER_STATUS.get(env.RUNNER_STATUS.idFromName("runner-pool")).fetch(request);
  },
};

/** One collector for the deployment, independent of browser count and Worker isolates. */
export class RunnerStatus {
  private cache = emptyCache();
  private inFlight: Promise<void> | null = null;
  constructor(private state: DurableObjectState, private env: Env) {
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<{ config: string; chunks: number }>("manifest");
      if (saved?.config === JSON.stringify(readConfig(env))) {
        const parts: string[] = [];
        for (let index = 0; index < saved.chunks; index++) {
          const part = await state.storage.get<string>(`cache:${index}`);
          if (part === undefined) throw new Error("Incomplete runner cache");
          parts.push(part);
        }
        this.cache = JSON.parse(parts.join("")) as Cache;
      }
    });
  }
  private poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      // The alarm is scheduled first so transient refresh/storage failures do not stop polling.
      await this.state.storage.setAlarm(Date.now() + refreshSeconds * 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const config = readConfig(this.env);
        this.cache = await refresh(config, this.cache, githubList(this.env.GITHUB_TOKEN, controller.signal));
        // Cache source data can exceed the per-value DO storage limit even when
        // the response is small. Commit bounded chunks and their manifest atomically.
        const serialized = JSON.stringify(this.cache);
        const parts: string[] = [];
        // A UTF-16 code unit can encode to three UTF-8 bytes (including lone
        // surrogates at a chunk boundary); leave room below the storage limit.
        for (let offset = 0; offset < serialized.length; offset += 16 * 1024) parts.push(serialized.slice(offset, offset + 16 * 1024));
        await this.state.storage.transaction(async storage => {
          const old = await storage.get<{ chunks: number }>("manifest");
          for (let index = 0; index < parts.length; index++) await storage.put(`cache:${index}`, parts[index]!);
          for (let index = parts.length; index < (old?.chunks ?? 0); index++) await storage.delete(`cache:${index}`);
          await storage.put("manifest", { config: JSON.stringify(config), chunks: parts.length });
        });
      } finally { clearTimeout(timer); }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async fetch(): Promise<Response> {
    if (!this.cache.snapshot) await this.poll();
    else if (Date.now() - Date.parse(this.cache.snapshot.checkedAt) >= refreshSeconds * 1000) this.state.waitUntil(this.poll());
    return Response.json(boundedSnapshot(this.cache.snapshot!), { headers });
  }
  async alarm(): Promise<void> { await this.poll(); }
}
