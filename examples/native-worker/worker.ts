import { DurableObject } from "cloudflare:workers";

interface Env {
  GREETING: string;
  API_TOKEN: string;
  COUNTERS: DurableObjectNamespace<Counter>;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  DB: D1Database;
  JOBS: Queue;
}

export class Counter extends DurableObject<Env> {
  increment() {
    this.ctx.storage.sql.exec("create table if not exists counter(n integer not null)");
    this.ctx.storage.sql.exec("insert into counter values(1)");
    return this.ctx.storage.sql.exec<{ n: number }>("select count(*) as n from counter").one().n;
  }
  fetch() { return Response.json({ count: this.increment() }); }
}

// This is an ordinary Worker. It does not import the host or an artifact SDK.
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/queue") {
      await env.JOBS.send({ message: "from fetch" });
      return new Response("queued");
    }
    if (url.pathname === "/events") return Response.json({ scheduled: await env.CACHE.get("scheduled", "json"), queued: await env.CACHE.get("queued", "json") });
    if (url.pathname === "/storage") return Response.json({ cached: await env.CACHE.get("last"), file: await (await env.FILES.get("last.txt"))?.text(),
      visits: await env.DB.prepare("select count(*) as n from visits").first<number>("n") });
    if (url.pathname === "/token-check") return Response.json({ matches: request.headers.get("x-token") === env.API_TOKEN });
    if (url.pathname === "/stream") return new Response(request.body);
    const counter = env.COUNTERS.get(env.COUNTERS.idFromName(url.searchParams.get("name") ?? "default"));
    const count = url.pathname === "/rpc" ? await counter.increment() : (await (await counter.fetch("https://counter.invalid/")).json() as { count: number }).count;
    await env.CACHE.put("last", String(count));
    await env.FILES.put("last.txt", String(count));
    await env.DB.prepare("create table if not exists visits(n integer)").run();
    await env.DB.prepare("insert into visits values(?)").bind(count).run();
    return Response.json({ greeting: env.GREETING, count, cached: await env.CACHE.get("last"), file: await (await env.FILES.get("last.txt"))!.text(),
      visits: await env.DB.prepare("select count(*) as n from visits").first<number>("n"), hasToken: !!env.API_TOKEN,
      bindings: Object.keys(env).sort() });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.CACHE.put("scheduled", JSON.stringify({ cron: controller.cron, time: controller.scheduledTime })));
  },
  async queue(batch: MessageBatch, env: Env) {
    await env.CACHE.put("queued", JSON.stringify({ queue: batch.queue, bodies: batch.messages.map(message => message.body) }));
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
