import { expect, test } from "bun:test";
import { Miniflare, Response as MFResponse, type MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authenticated viewers share a persisted collector; unauthorized calls never poll", async () => {
  const build = await Bun.build({ entrypoints: [new URL("./worker.ts", import.meta.url).pathname], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
  const script = await build.outputs[0]!.text();
  const directory = await mkdtemp(join(tmpdir(), "artifact-runner-test-"));
  let calls = 0;
  const options: MiniflareOptions = { cf: false, port: 0, resourcePersistencePath: directory, workers: [{
    config: { name: "runner-test", type: "worker", compatibilityDate: "2026-09-07",
      manifest: { mainModule: "worker.js", modulesRoot: import.meta.dir, modules: { "worker.js": { type: "esm", contents: script } } },
      env: { RUNNER_STATUS: { type: "durable-object", worker: "runner-test", exportName: "RunnerStatus" },
        ...Object.fromEntries(Object.entries({ GITHUB_TOKEN: "fixture-github-token", RUNNER_STATUS_TOKEN: "fixture-bridge-token", RUNNER_ORG: "example", RUNNER_REPOS: "example/app" }).map(([key, value]) => [key, { type: "text" as const, value }])) },
      exports: { RunnerStatus: { type: "durable-object", storage: "sqlite" } } },
    dev: { outboundService: { type: "fetcher", handler: request => {
      calls++;
      expect(request.headers.get("authorization")).toBe("Bearer fixture-github-token");
      expect(new URL(request.url).origin).toBe("https://api.github.com");
      return MFResponse.json(request.url.includes("/actions/runners") ? { runners: [{ id: 1, name: "runner", status: "online", busy: true, labels: [] }] } : { workflow_runs: [] });
    } } },
  }] };
  let mf = new Miniflare(options);
  const auth = { authorization: "Bearer fixture-bridge-token" };
  try {
    expect((await mf.dispatchFetch("https://collector/api/status")).status).toBe(401);
    expect((await mf.dispatchFetch("https://collector/api/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await mf.dispatchFetch("https://collector/api/status", { method: "POST", headers: auth })).status).toBe(405);
    expect((await mf.dispatchFetch("https://collector/other", { headers: auth })).status).toBe(404);
    expect(calls).toBe(0);
    const responses = await Promise.all(Array.from({ length: 8 }, () => mf.dispatchFetch("https://collector/api/status", { headers: auth }).then(response => response.json())));
    expect(responses[0]).toMatchObject({ errors: [] });
    expect(calls).toBe(6);
    expect(responses.every(value => JSON.stringify(value) === JSON.stringify(responses[0]))).toBe(true);
    expect(responses[0]).toMatchObject({ runners: [{ id: 1, busy: true }], errors: [] });
    await mf.dispose();
    mf = new Miniflare(options);
    const restored = await mf.dispatchFetch("https://collector/api/status", { headers: auth });
    expect(restored.headers.get("cache-control")).toBe("no-store");
    expect(await restored.json()).toEqual(responses[0]);
    expect(calls).toBe(6);
    // No viewer requests: the persisted alarm must continue polling by itself.
    const deadline = Date.now() + 50_000;
    while (calls < 12 && Date.now() < deadline) await Bun.sleep(250);
    expect(calls).toBe(12);

  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60000);

test("cache larger than a DO value persists and serves a visibly bounded snapshot", async () => {
  const build = await Bun.build({ entrypoints: [new URL("./worker.ts", import.meta.url).pathname], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), "artifact-runner-large-"));
  let calls = 0;
  const options: MiniflareOptions = { cf: false, port: 0, resourcePersistencePath: directory, workers: [{
    config: { name: "large-runner-test", type: "worker", compatibilityDate: "2026-09-07",
      manifest: { mainModule: "worker.js", modulesRoot: import.meta.dir, modules: { "worker.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
      env: { RUNNER_STATUS: { type: "durable-object", worker: "large-runner-test", exportName: "RunnerStatus" },
        ...Object.fromEntries(Object.entries({ GITHUB_TOKEN: "fixture", RUNNER_STATUS_TOKEN: "fixture", RUNNER_ORG: "example", RUNNER_REPOS: "example/app" }).map(([key, value]) => [key, { type: "text" as const, value }])) },
      exports: { RunnerStatus: { type: "durable-object", storage: "sqlite" } } },
    dev: { outboundService: { type: "fetcher", handler: request => {
      calls++;
      if (request.url.includes("/actions/runners")) return MFResponse.json({ runners: [] });
      if (request.url.includes("/jobs?")) return MFResponse.json({ jobs: Array.from({ length: 600 }, (_, id) => ({ id, name: `Job ${id} ${"界".repeat(2000)}`, status: "queued", html_url: "https://github.com/example/app/actions/runs/7", labels: ["self-hosted"], steps: [] })) });
      return MFResponse.json({ workflow_runs: [{ id: 7, name: "CI", display_title: "Test", status: "queued", html_url: "https://github.com/example/app/actions/runs/7", head_branch: "main", head_sha: "abc", created_at: "2026-09-07T00:00:00Z", run_number: 1, run_attempt: 1 }] });
    } } },
  }] };
  let mf = new Miniflare(options);
  const get = () => mf.dispatchFetch("https://collector/api/status", { headers: { authorization: "Bearer fixture" } });
  try {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(230 * 1024);
    const snapshot = JSON.parse(body);
    expect(snapshot.jobs.length).toBeGreaterThan(0);
    expect(snapshot.jobs.length).toBeLessThan(600);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain("omitted");
    expect(calls).toBe(7);
    await mf.dispose(); mf = new Miniflare(options);
    expect(await (await get()).json()).toEqual(snapshot);
    expect(calls).toBe(7);
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
