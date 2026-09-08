import { DurableObject } from "cloudflare:workers";

export class ArtifactServer extends DurableObject {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== "/counter") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key, value integer not null)");
    this.ctx.storage.sql.exec("insert or ignore into counter values (1, 0)");
    if (request.method === "POST") {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("update counter set value = value + 1 where id = 1");
        this.ctx.storage.kv.put("lastUpdated", new Date().toISOString());
      });
    }
    const row = this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one();
    return Response.json({ value: row.value, lastUpdated: this.ctx.storage.kv.get("lastUpdated") ?? null });
  }
}
