import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { GalleryData } from "../src/gallery/types";
import { openGallerySubscription } from "../src/test/gallery-subscription";

test("gallery lists Worker drafts across workspaces with owner isolation, pagination and live updates", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./native-gallery-test-worker.ts", import.meta.url).pathname], target: "browser", format: "esm", external: ["cloudflare:workers", "node:*", "fs", "fs/promises"],
    plugins: [{ name: "draft-only-compiler", setup(build) {
      // Persist real controller drafts without contacting a deployment provider.
      build.onLoad({ filter: /\/cloudflare\/compiler\.ts$/ }, () => ({ loader: "ts", contents: `
        export function compileNativeWorker() { return { ok: false, diagnostics: [{ severity: "error", message: "Fixture draft" }] }; }
        function unexpected() { throw new Error("Gallery reads must not compile or execute projects"); }
        export { unexpected as compileArtifactSource, unexpected as compileArtifactServerSource, unexpected as compileScriptSource,
          unexpected as typecheckArtifactSource, unexpected as typecheckArtifactServerSource };
      ` }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const bindings = { LIBRARIES: "ArtifactLibrary", SCRIPTS: "ScriptLibrary", LINKS: "ArtifactLinks", NATIVE_APPS: "NativeApps" };
  const runtime = new Miniflare({ cf: false, port: 0, workers: [{ config: {
    name: "native-gallery-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot: import.meta.dir, modules: { "worker.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: {
      ...Object.fromEntries(Object.entries(bindings).map(([name, exportName]) => [name, { type: "durable-object", worker: "native-gallery-test", exportName }])),
      NATIVE_CF_ACCOUNT_ID: { type: "text", value: "a".repeat(32) }, NATIVE_CF_API_TOKEN: { type: "text", value: "fixture-provider-secret" },
    },
    exports: Object.fromEntries(Object.values(bindings).map(name => [name, { type: "durable-object", storage: "sqlite" }])),
  }, dev: {} }] } as ConstructorParameters<typeof Miniflare>[0]);
  const origin = (await runtime.ready).origin;
  async function request(path: string, input?: unknown) {
    const response = await fetch(`${origin}${path}`, input === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  const gallery = (params = ""): Promise<GalleryData> => request(`/gallery?${params}`);
  const write = (name: string, params = "") => request(`/tools?${params}`, { name: "app_write", arguments: {
    name, source: "private draft source", manifest: { main: "worker.ts", compatibility_date: "2026-09-06" }, expected_revision: null,
  } });
  const subscriptions = await Promise.all([
    openGallerySubscription(`${origin}/subscribe?all=1`),
    openGallerySubscription(`${origin}/subscribe?workspace=other`),
    openGallerySubscription(`${origin}/subscribe?owner=bob&all=1`),
    openGallerySubscription(`${origin}/subscribe?owner=team&all=1`),
  ]);
  const [alice, otherWorkspace, bob, team] = subscriptions;
  try {
    await request("/seed-artifact", {});
    await write("example");
    expect(await alice!.changes()).toEqual(["changed"]);
    expect(await otherWorkspace!.changes()).toEqual([]);
    expect(await bob!.changes()).toEqual([]);
    expect(await team!.changes()).toEqual([]);
    await write("example", "workspace=other");
    await write("bob-only", "owner=bob");
    const all = await gallery("all=1");
    expect(all.artifacts.map(item => item.name)).toEqual(["report"]);
    expect(all.workerApps?.map(item => [item.name, item.workspace, item.kind])).toEqual([["example", "default", "worker"], ["example", "other", "worker"]]);
    expect(new Set(all.workerApps?.map(item => item.key)).size).toBe(2);
    expect(all.nativeAppProviders).toEqual(["cloudflare"]);
    expect(JSON.stringify(all)).not.toContain("private draft source");
    expect(JSON.stringify(all)).not.toContain("fixture-provider-secret");
    expect((await gallery()).workerApps?.map(item => item.workspace)).toEqual(["default"]);
    expect((await gallery("owner=bob&all=1")).workerApps?.map(item => item.name)).toEqual(["bob-only"]);
    for (let index = 0; index < 100; index++) await write(`worker-${String(index).padStart(3, "0")}`, "workspace=other");
    const first = await gallery("all=1"), second = await gallery("all=1&offset=100");
    expect(first.workerApps).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    expect(second.workerApps).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.workerApps!, ...second.workerApps!].map(item => item.key)).size).toBe(102);
    // Moving an app invalidates both libraries and removes the old owner's row.
    await Promise.all(subscriptions.map(subscription => subscription.changes()));
    await request("/tools", { name: "app_move", arguments: { name: "example", library: "team" } });
    expect(await alice!.changes()).toEqual(["changed"]);
    expect(await team!.changes()).toEqual(["changed"]);
    expect(await bob!.changes()).toEqual([]);
    expect(await otherWorkspace!.changes()).toEqual([]);
    expect((await gallery()).workerApps).toEqual([]);
    expect((await gallery("owner=team&all=1")).workerApps?.map(item => item.name)).toEqual(["example"]);
  } finally {
    subscriptions.forEach(subscription => subscription.close());
    await runtime.dispose();
  }
}, 30000);
