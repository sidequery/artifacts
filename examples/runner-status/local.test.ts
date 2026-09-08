import { expect, test } from "bun:test";
import { localOptions, seed } from "./local";

test("local configuration is explicit and portable", () => {
  expect(() => localOptions({})).toThrow("Configure RUNNER_ORG");
  const env = { RUNNER_ORG: "example", RUNNER_REPOS: "example/api,example/web", RUNNER_NAME_PREFIX: "pool-" };
  expect(localOptions(env)).toMatchObject({ config: { org: "example", repos: ["example/api", "example/web"], runnerPrefix: "pool-" }, port: 4786 });
  expect(localOptions({ ...env, RUNNER_PORT: "5123", RUNNER_STATE_DIR: "/tmp/custom-runner-state" })).toMatchObject({ port: 5123, directory: "/tmp/custom-runner-state" });
  for (const port of ["0", "65536", "abc", "4786.5"]) expect(() => localOptions({ ...env, RUNNER_PORT: port })).toThrow("RUNNER_PORT");
});

test("first start seeds a private canvas; restart preserves edited source", async () => {
  let source: string | undefined;
  let slug: string | undefined;
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/source") return new Response(source ?? "Missing", { status: source ? 200 : 404 });
    if (new URL(request.url).pathname === "/api/gallery") return Response.json({ artifacts: [{ name: "runner-status", kind: "canvas", slug }], nextOffset: null });
    expect(request.headers.get("origin")).toBe(new URL(request.url).origin);
    const body = await request.json() as { name: string; arguments: Record<string, string> };
    calls.push(body.name);
    if (body.name === "canvas_write") { source = body.arguments.contents; expect(source).toContain("pluginCall"); }
    if (body.name === "artifact_link") {
      expect(body.arguments).toEqual({ kind: "canvas", name: "runner-status", slug: "runner-status", access: "private" });
      slug = body.arguments.slug;
    }
    return Response.json({ isError: false, structuredContent: { ok: true } });
  } });
  try {
    await seed(server.url.origin);
    expect(calls).toEqual(["canvas_guide", "canvas_write", "artifact_link"]);
    source = "user-edited source";
    await seed(server.url.origin);
    expect(source).toBe("user-edited source");
    expect(calls).toHaveLength(3);
    slug = undefined;
    await seed(server.url.origin);
    expect(source).toBe("user-edited source");
    expect(calls).toEqual(["canvas_guide", "canvas_write", "artifact_link", "artifact_link"]);
    slug = "custom-url";
    expect(await seed(server.url.origin)).toBe(`${server.url.origin}/custom-url`);
    expect(calls).toHaveLength(4);
  } finally { server.stop(true); }
});

test("seeding stops when compilation fails", async () => {
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/source") return new Response("Missing", { status: 404 });
    const body = await request.json() as { name: string };
    calls.push(body.name);
    return Response.json({ isError: body.name === "canvas_write" });
  } });
  try {
    await expect(seed(server.url.origin)).rejects.toThrow("canvas_write failed");
    expect(calls).toEqual(["canvas_guide", "canvas_write"]);
  } finally { server.stop(true); }
});
