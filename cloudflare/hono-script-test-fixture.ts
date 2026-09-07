import { Hono } from "hono";

const app = new Hono();
app.post("/chosen/:segment", async context => context.json({
  framework: "hono",
  segment: context.req.param("segment"),
  query: context.req.query("one"),
  method: context.req.method,
  header: context.req.header("x-original"),
  body: await context.req.text(),
}, 201));

export default app;
