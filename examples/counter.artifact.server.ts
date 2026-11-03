export default {
  fetch(request: Request, env: ServerEnv): Response {
    if (new URL(request.url).pathname !== "/counter") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    env.sql.exec("create table if not exists counter (id integer primary key, value integer not null)");
    env.sql.exec("insert or ignore into counter values (1, 0)");
    if (request.method === "POST") {
      env.storage.transactionSync(() => {
        env.sql.exec("update counter set value = value + 1 where id = 1");
        env.storage.kv.put("lastUpdated", new Date().toISOString());
      });
    }
    const row = env.sql.exec<{ value: number }>("select value from counter where id = 1").one();
    return Response.json({ value: row.value, lastUpdated: env.storage.kv.get("lastUpdated") ?? null });
  },
} satisfies ExportedHandler<ServerEnv>;
