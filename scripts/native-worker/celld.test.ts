import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCelldRuntime } from "../../src/local/celld-runtime";
import { loadProject } from "./host";
import { appScope, planResources } from "./manifest";

// Qualify native binding/event compatibility separately from the workerd
// deployment controller. This does not claim celld upgrade-provider support.
test.skipIf(process.env.NATIVE_WORKER_CELLD !== "1")("ordinary Worker uses native resources and queue delivery on pinned celld", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-celld-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let logs = "";
  try {
    const binary = process.env.CELLD_BIN ?? await ensureCelldRuntime({ dataRoot: join(directory, "runtime") });
    const project = await loadProject(join(import.meta.dir, "../../examples/native-worker/app.json"));
    const resources = planResources(appScope("local", "celld-test"), project.manifest, {});
    const config = {
      name: "native-worker-test", main: "worker.js", compatibility_date: project.manifest.compatibility_date,
      compatibility_flags: project.manifest.compatibility_flags,
      // These are test fixtures in disposable scratch storage, not app exports.
      vars: { ...project.manifest.vars, API_TOKEN: "test-fixture" },
      durable_objects: { bindings: [{ name: "COUNTERS", class_name: "Counter" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
      kv_namespaces: [{ binding: "CACHE", id: resources.cache!.id }],
      r2_buckets: [{ binding: "FILES", bucket_name: resources.files!.id }],
      d1_databases: [{ binding: "DB", database_name: resources.database!.id, database_id: resources.database!.id }],
      queues: { producers: [{ binding: "JOBS", queue: resources.jobs!.id }], consumers: [{ queue: resources.jobs!.id, max_batch_timeout: 0 }] },
    };
    await Bun.write(join(directory, "worker.js"), project.code);
    await Bun.write(join(directory, "wrangler.jsonc"), JSON.stringify(config));
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const url = `http://127.0.0.1:${listener.port}`;
    listener.stop(true);
    child = Bun.spawn([binary, "dev", directory, "--host", "127.0.0.1", "--port", new URL(url).port, "--no-watch"], {
      cwd: directory, env: { ...process.env, CELLD_ESBUILD: join(import.meta.dir, "../../node_modules/.bin/esbuild") }, stdout: "pipe", stderr: "pipe",
    });
    for (const stream of [child.stdout, child.stderr]) if (stream && typeof stream !== "number") void (async () => {
      for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 45_000;
    let first: any;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const response = await fetch(url); if (response.ok) { first = await response.json(); break; } } catch {}
      await Bun.sleep(100);
    }
    expect(first, logs).toMatchObject({ count: 1, cached: "1", file: "1", visits: 1, hasToken: true });
    expect(await (await fetch(url + "/rpc")).json()).toMatchObject({ count: 2, visits: 2 });
    expect(await (await fetch(url + "/queue")).text()).toBe("queued");
    let events: any;
    const queueDeadline = Date.now() + 10_000;
    do { events = await (await fetch(url + "/events")).json(); if (events.queued) break; await Bun.sleep(100); } while (Date.now() < queueDeadline);
    expect(events.queued, logs).toEqual({ queue: resources.jobs!.id, bodies: [{ message: "from fetch" }] });
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGINT");
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
      if (!stopped) { child.kill("SIGKILL"); await child.exited; }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
