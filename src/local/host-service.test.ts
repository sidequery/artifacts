import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRuntimeEnvironment, seedRunner } from "./host-service";

test("runner startup seeds once, recovers missing link and preserves renamed links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-host-seed-"));
  const source = join(directory, "runner.canvas.tsx"); await writeFile(source, "original canvas");
  let saved: string | undefined, slug: string | undefined;
  const tools: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/source") return new Response(saved, { status: saved ? 200 : 404 });
    if (url.pathname === "/api/gallery") return Response.json({ artifacts: saved ? [{ name: "runner-status", kind: "artifact", slug }] : [], nextOffset: null });
    const call = await request.json() as { name: string; arguments: { contents: string; slug: string } };
    tools.push(call.name);
    if (call.name === "artifact_write") saved = call.arguments.contents;
    if (call.name === "artifact_link") slug = call.arguments.slug;
    return Response.json({ structuredContent: { ok: true } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    expect(await seedRunner(origin, source)).toBe(`${origin}/runner-status`);
    expect(tools).toEqual(["artifact_guide", "artifact_write", "artifact_link"]);
    saved = "user edits"; slug = "custom-runners"; tools.length = 0;
    expect(await seedRunner(origin, source)).toBe(`${origin}/custom-runners`);
    expect(tools).toEqual([]); expect(saved).toBe("user edits");
    slug = undefined;
    expect(await seedRunner(origin, source)).toBe(`${origin}/runner-status`);
    expect(tools).toEqual(["artifact_link"]); expect(saved).toBe("user edits");
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});


test("keep-warm removes timed eviction without inheriting parent runtime overrides", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/user", CELLD_IDLE_EVICT_S: "1", GITHUB_TOKEN: "secret" };
  const normal = hostRuntimeEnvironment({ esbuild: "/release/esbuild" }, env);
  expect(normal.CELLD_IDLE_EVICT_S).toBe("60");
  const warm = hostRuntimeEnvironment({ esbuild: "/release/esbuild", keepWarm: true }, env);
  expect(Object.hasOwn(warm, "CELLD_IDLE_EVICT_S")).toBe(false);
  expect(warm.CELLD_ESBUILD).toBe("/release/esbuild");
  expect(warm.CELLD_MAX_RSS_MB).toBeUndefined();
  expect(warm.CELLD_MAX_RESIDENT_CELLS).toBeUndefined();
  expect(warm.GITHUB_TOKEN).toBeUndefined();
});

test("targeted warming requests only selected management GETs sequentially", async () => {
  const { startHostWarmer } = await import("./host-service");
  const requests: { method: string; path: string }[] = [];
  let active = 0, maximum = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    active++; maximum = Math.max(maximum, active);
    const url = new URL(request.url); requests.push({ method: request.method, path: url.pathname + url.search });
    await Bun.sleep(10); active--;
    return new Response("ready");
  } });
  const warmer = startHostWarmer({ gateway: { publicOrigin: "https://host.ts.net", upstreamOrigin: `http://127.0.0.1:${server.port}`, allowedLogin: "user", port: 4789 }, warmGallery: true, warmCanvases: ["runner-status"] }, { intervalMs: 5 });
  try {
    const deadline = Date.now() + 2000;
    while (requests.length < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(requests.slice(0, 4)).toEqual([
      { method: "GET", path: "/api/gallery" }, { method: "GET", path: "/gallery/preview?name=runner-status" },
      { method: "GET", path: "/api/gallery" }, { method: "GET", path: "/gallery/preview?name=runner-status" },
    ]);
    expect(maximum).toBe(1);
    await warmer.stop();
    const stoppedCount = requests.length; await Bun.sleep(30);
    expect(requests.length).toBe(stoppedCount);
  } finally { await warmer.stop(); server.stop(true); }
});

test("targeted warmer aborts an in-flight read on shutdown", async () => {
  const { startHostWarmer } = await import("./host-service");
  let entered!: () => void, release!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { entered(); await stalled; return new Response("done"); } });
  const warmer = startHostWarmer({ gateway: { publicOrigin: "https://host.ts.net", upstreamOrigin: `http://127.0.0.1:${server.port}`, allowedLogin: "user", port: 4789 }, warmGallery: true }, { timeoutMs: 5000 });
  try {
    await requested;
    const started = Date.now(); await warmer.stop();
    expect(Date.now() - started).toBeLessThan(500);
  } finally { release(); await warmer.stop(); server.stop(true); }
});

test("warm failures log only changes and invalid canvas names are rejected", async () => {
  const { startHostWarmer, validateWarmCanvases } = await import("./host-service");
  for (const names of [[""], ["bad\0name"], ["é".repeat(2049)], Array(21).fill("artifact")]) expect(() => validateWarmCanvases(names)).toThrow();
  expect(validateWarmCanvases(["runner-status", "runner-status"])).toEqual(["runner-status"]);
  let requests = 0; const warnings: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("unavailable", { status: 503 }); } });
  const warmer = startHostWarmer({ gateway: { publicOrigin: "https://host.ts.net", upstreamOrigin: `http://127.0.0.1:${server.port}`, allowedLogin: "user", port: 4789 }, warmGallery: true }, { intervalMs: 5, warn: message => warnings.push(message) });
  try {
    const deadline = Date.now() + 2000;
    while (requests < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(warnings).toEqual(["Canvas targeted warm-up: HTTP 503"]);
  } finally { await warmer.stop(); server.stop(true); }
});
