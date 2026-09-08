import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

async function start(directory: string, identity: string) {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "compiled-canvas-test-worker.ts")], target: "node", format: "esm", external: ["cloudflare:workers"],
    plugins: [{ name: "compiler-probe", setup(build) {
      build.onLoad({ filter: /\/cloudflare\/compiler\.ts$/ }, () => ({ loader: "ts", contents: `
        globalThis.compilerProbe = { allowed: true, client: 0, server: 0 };
        function compile(source, kind, project) {
          if (!globalThis.compilerProbe.allowed) throw new Error("Compilation was invoked by a read");
          globalThis.compilerProbe[kind]++;
          return source.includes("invalid") ? { ok: false, diagnostics: [{ severity: "error", message: "Invalid source" }] }
            : { ok: true, js: JSON.stringify({ source, kind, project, runtime: ${JSON.stringify(identity)} }), diagnostics: [] };
        }
        export async function compileCanvasSource(source, project) { return compile(source, "client", project); }
        export async function compileCanvasServerSource(source, project) { return compile(source, "server", project); }
        export async function compileScriptSource() { throw new Error("Unexpected script compile"); }
        export function typecheckCanvasSource() { return []; }
        export function typecheckCanvasServerSource() { return []; }
      ` }));
      build.onLoad({ filter: /\/dist\/cloudflare\/identity\.json$/ }, () => ({ loader: "json", contents: JSON.stringify({ runtime: identity }) }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const runtime = new Miniflare({ cf: false, port: 0, resourcePersistencePath: directory, workers: [{ config: {
    name: "compiled-canvas-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "worker.js", modulesRoot: import.meta.dir, modules: { "worker.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: { LIBRARY: { type: "durable-object", worker: "compiled-canvas-test", exportName: "CanvasLibrary" }, LINKS: { type: "durable-object", worker: "compiled-canvas-test", exportName: "ArtifactLinks" } },
    exports: { CanvasLibrary: { type: "durable-object", storage: "sqlite" }, ArtifactLinks: { type: "durable-object", storage: "sqlite" } },
  }, dev: {} }] });
  await runtime.ready;
  return runtime;
}

test("edits persist compiled revisions; every read and restart works with the compiler disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-compiled-"));
  let runtime = await start(directory, "runtime-one");
  async function call(path: string, input: unknown = {}) {
    const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(input) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  const tool = (name: string, args: unknown) => call("/tool", { name, arguments: args });
  const result = (value: any) => JSON.parse(value.content[0].text);
  try {
    const first = await tool("canvas_write", { name: "example", contents: "client-one", server: "server-one", slug: "example" });
    expect(first.isError).not.toBe(true);
    const firstCanvas = first._meta.canvas;
    const firstVersion = firstCanvas.versionId;
    expect(await call("/compiler", { allowed: false })).toMatchObject({ client: 1, server: 1 });
    for (let index = 0; index < 3; index++) {
      expect((await tool("canvas_open", { name: "example" }))._meta.canvas.js).toBe(firstCanvas.js);
      expect((await call("/preview", { version_id: firstVersion }))._meta.canvas.js).toBe(firstCanvas.js);
      expect((await call("/active", { slug: "example" }))._meta.canvas.js).toBe(firstCanvas.js);
      const response = await call("/request", { version_id: firstVersion });
      expect(JSON.parse(atob(response.body)).code).toContain("server-one");
    }
    await call("/state", { name: "example", key: "count", value: 7 });
    expect((await call("/preview", { name: "example" }))._meta.canvas.state).toEqual({ count: 7 });
    expect(await call("/compiler", { allowed: true })).toMatchObject({ client: 1, server: 1 });
    const serverEdit = await tool("canvas_edit", { name: "example", part: "server", edits: [{ old_text: "server-one", new_text: "server-two" }] });
    expect(serverEdit.isError).not.toBe(true);
    const secondVersion = serverEdit._meta.canvas.versionId;
    expect(secondVersion).not.toBe(firstVersion);
    const invalid = await tool("canvas_edit", { name: "example", edits: [{ old_text: "client-one", new_text: "invalid" }] });
    expect(invalid.isError).not.toBe(false);
    expect(result(invalid).ok).toBe(false);
    await call("/compiler", { allowed: false });
    expect((await call("/active", { slug: "example" }))._meta.canvas.versionId).toBe(secondVersion);
    expect((await call("/preview", { name: "example" })).ok).toBe(false);
    expect(JSON.parse(atob((await call("/request", { version_id: firstVersion })).body)).code).toContain("server-one");
    await call("/compiler", { allowed: true });
    const restored = await tool("canvas_restore", { version_id: firstVersion });
    expect(restored.isError).not.toBe(true);
    expect(restored._meta.canvas.js).toBe(firstCanvas.js);
    const restoredVersion = restored._meta.canvas.versionId;
    expect(restoredVersion).not.toBe(firstVersion);
    expect(result(restored).versionId).toBe(restoredVersion);

    await runtime.dispose();
    runtime = await start(directory, "runtime-two");
    await call("/compiler", { allowed: false });
    expect((await call("/active", { slug: "example" }))._meta.canvas.js).toBe(firstCanvas.js);
    expect((await call("/preview", { version_id: firstVersion }))._meta.canvas.js).toBe(firstCanvas.js);
    expect(JSON.parse(atob((await call("/request", { version_id: restoredVersion })).body)).code).toContain("runtime-one");
    const history = result(await tool("canvas_version", { version_id: firstVersion }));
    expect(history.events[0].runtime).toBe("runtime-one");
    expect(await call("/compiler", { allowed: false })).toMatchObject({ client: 0, server: 0 });
    expect(result(await tool("canvas_compile", { version_id: firstVersion })).ok).toBe(true);
    await call("/compiler", { allowed: true });
    const upgraded = await tool("canvas_write", { name: "example", contents: "client-one", server: "server-one" });
    expect(upgraded._meta.canvas.js).toContain("runtime-two");
    expect(upgraded._meta.canvas.versionId).not.toBe(restoredVersion);
    await call("/compiler", { allowed: false });
    expect((await call("/preview", { version_id: firstVersion }))._meta.canvas.js).toBe(firstCanvas.js);
    expect((await call("/active", { slug: "example" }))._meta.canvas.js).toBe(upgraded._meta.canvas.js);

    // Project-only edits compile fresh output and preserve archived replay and remix snapshots.
    await call("/compiler", { allowed: true });
    const projectWrite = await tool("canvas_write", { name: "project", contents: "project-client", server: "project-server", project: { files: { "helper.ts": "original-helper" } } });
    expect(projectWrite.isError).not.toBe(true);
    const projectFirst = projectWrite._meta.canvas;
    const projectEdit = await tool("canvas_edit", { name: "project", file: "helper.ts", edits: [{ old_text: "original-helper", new_text: "updated-helper" }] });
    expect(projectEdit.isError).not.toBe(true);
    expect(projectEdit._meta.canvas.js).toContain("updated-helper");
    expect(projectEdit._meta.canvas.js).not.toBe(projectFirst.js);
    expect(projectEdit._meta.canvas.versionId).not.toBe(projectFirst.versionId);
    await call("/compiler", { allowed: false });
    expect((await call("/preview", { version_id: projectFirst.versionId }))._meta.canvas.js).toBe(projectFirst.js);
    expect((await tool("canvas_open", { name: "project" }))._meta.canvas.js).toBe(projectEdit._meta.canvas.js);
    expect(JSON.parse(atob((await call("/request", { version_id: projectFirst.versionId })).body)).code).toContain("original-helper");
    await call("/compiler", { allowed: true });
    const remixed = await tool("canvas_remix", { version_id: projectFirst.versionId, new_name: "project-remix" });
    expect(remixed.isError).not.toBe(true);
    expect(remixed._meta.canvas.js).toContain("original-helper");
    expect(remixed._meta.canvas.js).not.toContain("updated-helper");
    await call("/compiler", { allowed: false });

    // Source-only legacy revisions are migrated explicitly, never during reads.
    const legacy = await call("/legacy", { name: "legacy", source: "legacy-source", server_source: null });
    expect((await call("/preview", { version_id: legacy.version.id })).check).toContain("canvas_compile");
    expect(await call("/compiler", { allowed: true })).toMatchObject({ client: 4, server: 4 });
    expect(result(await tool("canvas_compile", { name: "legacy" })).ok).toBe(true);
    // Compiling a draft must not silently pin or change an archived revision.
    await call("/compiler", { allowed: false });
    expect((await call("/preview", { version_id: legacy.version.id })).check).toContain("canvas_compile");
    await call("/compiler", { allowed: true });
    expect(result(await tool("canvas_compile", { version_id: legacy.version.id })).ok).toBe(true);
    await call("/compiler", { allowed: false });
    expect((await call("/preview", { version_id: legacy.version.id }))._meta.canvas.js).toContain("legacy-source");
    expect(await call("/compiler", { allowed: false })).toMatchObject({ client: 5, server: 4 });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60000);
