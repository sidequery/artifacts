import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
let runtime: Miniflare;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [new URL("./links-test-worker.ts", import.meta.url).pathname], target: "node", format: "esm", external: ["cloudflare:workers"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime = new Miniflare({ cf: false, port: 0, workers: [{ config: {
    name: "links-test", type: "worker", compatibilityDate: "2026-09-06",
    manifest: { mainModule: "test.js", modulesRoot: import.meta.dir, modules: { "test.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: { LINKS: { type: "durable-object", worker: "links-test", exportName: "ArtifactLinks" } },
    exports: { ArtifactLinks: { type: "durable-object", storage: "sqlite" } },
  }, dev: {} }] });
  await runtime.ready;
});
afterAll(async () => { await runtime?.dispose(); });
async function call(method: string, ...args: unknown[]): Promise<any> {
  const response = await runtime.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ method, args }) });
  const result = await response.json() as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(result.error);
  return result.result;
}
const owner = { libraryKey: "alice", workspace: "default", kind: "script", name: "handler" };
test("slugs are unique across libraries and kinds; code and access change atomically", async () => {
  const generation = await call("begin", owner);
  expect(await call("get", "chosen")).toBeNull();
  await call("commit", owner, generation, { slug: "chosen", access: "private", script_hash: "first" });
  await expect(call("check", { ...owner, libraryKey: "bob" }, "chosen")).rejects.toThrow("already in use");
  await expect(call("check", { ...owner, kind: "canvas" }, "chosen")).rejects.toThrow("already in use");
  for (const slug of ["api", "mcp", "gallery", "health", "sign-in", "consent", "bad/path", "Upper", "-bad", "bad-", ""]) {
    await expect(call("check", owner, slug)).rejects.toThrow("Slug must");
  }
  const pending = await call("begin", owner);
  expect(await call("get", "chosen")).toMatchObject({ access: "private", script_hash: "first" });
  await call("commit", owner, pending, { access: "public", script_hash: "second" });
  expect(await call("get", "chosen")).toMatchObject({ access: "public", script_hash: "second" });
});
test("newer writes and explicit revocation supersede in-flight URL activations", async () => {
  const stale = await call("begin", owner);
  const latest = await call("begin", owner);
  expect(await call("commit", owner, stale, { access: "public", script_hash: "stale" })).toBeNull();
  await call("commit", owner, latest, { script_hash: "latest" });
  const beforeRevoke = await call("begin", owner);
  await call("set", { ...owner, slug: "renamed", access: "private" });
  expect(await call("get", "chosen")).toBeNull();
  expect(await call("get", "renamed")).toMatchObject({ access: "private", script_hash: "latest" });
  expect(await call("commit", owner, beforeRevoke, { access: "public", script_hash: "older" })).toBeNull();
  expect(await call("get", "renamed")).toMatchObject({ access: "private", script_hash: "latest" });
});

test("invalid drafts retain chosen metadata without exposing a URL, and successful activation consumes it", async () => {
  const target = { ...owner, name: "Display name with spaces" };
  const invalid = await call("begin", target);
  expect(await call("stage", target, invalid, { slug: "readable-slug", access: "public" })).toBe(true);
  expect(await call("draft", target)).toEqual({ slug: "readable-slug", access: "public" });
  expect(await call("get", "readable-slug")).toBeNull();
  expect(await call("find", target)).toBeNull();
  const fixed = await call("begin", target);
  expect(await call("stage", target, invalid, { slug: "stale-slug" })).toBe(false);
  expect(await call("commit", target, invalid, { script_hash: "stale" })).toBeNull();
  expect(await call("stage", target, fixed, {})).toBe(true);
  await call("commit", target, fixed, { script_hash: "validated" });
  expect(await call("get", "readable-slug")).toMatchObject({ name: target.name, access: "public", script_hash: "validated" });
  expect(await call("draft", target)).toEqual({});
});

test("explicit private access clears invalid pending public intent before subsequent source corrections", async () => {
  const target = { ...owner, kind: "canvas", name: "private-canvas" };
  const first = await call("begin", target);
  await call("commit", target, first, { slug: "private-canvas", access: "private", version_id: "first" });
  const invalid = await call("begin", target);
  await call("stage", target, invalid, { slug: "pending-canvas", access: "public" });
  expect(await call("get", "private-canvas")).toMatchObject({ access: "private", version_id: "first" });
  expect(await call("get", "pending-canvas")).toBeNull();
  await call("set", { ...target, slug: "private-canvas", access: "private" });
  expect(await call("draft", target)).toEqual({});
  expect(await call("stage", target, invalid, { access: "public" })).toBe(false);
  const fixed = await call("begin", target);
  await call("commit", target, fixed, { version_id: "fixed" });
  expect(await call("get", "private-canvas")).toMatchObject({ access: "private", version_id: "fixed" });
  expect(await call("get", "pending-canvas")).toBeNull();
});
