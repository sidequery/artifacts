import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

let runtime: Miniflare;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [new URL("./ownership-test-worker.ts", import.meta.url).pathname], target: "node", format: "esm", external: ["cloudflare:workers"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime = new Miniflare({ cf: false, port: 0, unsafeInspectDurableObjects: true, workers: [{ config: {
    name: "ownership-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
    manifest: { mainModule: "test.js", modulesRoot: import.meta.dir, modules: { "test.js": { type: "esm", contents: await build.outputs[0]!.text() } } },
    env: Object.fromEntries([["LIBRARIES", "ArtifactLibrary"], ["SCRIPTS", "ScriptLibrary"], ["LINKS", "ArtifactLinks"]].map(([binding, exportName]) => [binding, { type: "durable-object", worker: "ownership-test", exportName }])),
    exports: Object.fromEntries(["ArtifactLibrary", "ScriptLibrary", "ArtifactLinks"].map(name => [name, { type: "durable-object", storage: "sqlite" }])),
  }, dev: {} }] } as ConstructorParameters<typeof Miniflare>[0]);
  await runtime.ready;
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });
async function call(binding: "LIBRARIES" | "SCRIPTS" | "LINKS", library: string, method: string, ...args: unknown[]): Promise<any> {
  const response = await runtime.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ binding, library, method, args }) });
  const result = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(result.error);
  return result.result;
}
const links = (method: string, ...args: unknown[]) => call("LINKS", "deployment", method, ...args);

for (const kind of ["artifact", "script"] as const) {
  const binding = kind === "artifact" ? "LIBRARIES" : "SCRIPTS";
  test(`${kind}: moves preserve physical source, projects, history, state/secrets and links; both directions enforce ownership`, async () => {
    const workspace = `preserve-${kind}`, name = "existing", original = { libraryKey: "alice", workspace, kind, name };
    const source = "original source\n", project = { files: { "helper.ts": "export const value = 7;" }, dependencies: {}, lock: {} };
    await call(binding, "alice", "writeDraft", { workspace, name, source, project, ...(kind === "artifact" ? { server_source: "server source" } : {}) });
    if (kind === "artifact") {
      await call(binding, "alice", "setState", { workspace, name, key: "saved", value: 42 });
      await call(binding, "alice", "recordServe", { workspace, name, source, server_source: "server source", project, runtime: "test", initial_state: { replay: 3 }, mode: "live" });
    } else await call(binding, "alice", "setSecret", { workspace, name, key: "TOKEN", value: "retained-secret" });
    const before = await call(binding, "alice", "history", { workspace, name });
    const version_id = before[0].version_id;
    const versionBefore = await call(binding, "alice", "version", { workspace, id: version_id });
    const generation = await links("begin", original);
    await links("commit", original, generation, { slug: `preserve-${kind}`, access: "private", ...(kind === "artifact" ? { version_id } : { script_hash: "validated" }) });
    const linkBefore = await links("find", original);
    await expect(links("admit", { ...original, libraryKey: "bob", name: undefined, version_id })).rejects.toThrow("not found");
    await expect(links("move", { ...original, libraryKey: "bob" }, "team")).rejects.toThrow("not found");
    expect(await links("move", original, "team")).toEqual({ workspace, name, kind });
    expect(await links("admit", { ...original, libraryKey: "team" })).toEqual(original);
    expect(await links("admit", { ...original, libraryKey: "team", name: undefined, version_id })).toEqual(original);
    await expect(links("admit", original)).rejects.toThrow("not found");
    await expect(links("admit", { ...original, name: undefined, version_id })).rejects.toThrow("not found");
    expect(await links("owner", original)).toBe("team");
    expect(await links("find", original)).toEqual(linkBefore);
    expect(await call(binding, "alice", "version", { workspace, id: version_id })).toEqual(versionBefore);
    expect(await call(binding, "alice", "readRange", { workspace, name })).toMatchObject({ source, project });
    if (kind === "artifact") expect(await call(binding, "alice", "getState", { workspace, name })).toMatchObject({ saved: 42 });
    else expect(await call(binding, "alice", "executionSecrets", { workspace, name })).toEqual({ TOKEN: "retained-secret" });
    expect(await links("catalog", { libraryKey: "alice", workspace, kind, method: "history" })).toEqual([]);
    expect(await links("catalog", { libraryKey: "team", workspace, kind, method: "history" })).toEqual(before);
    // Any authenticated team member can explicitly move the team-owned item into
    // their own library; the original creator has no retained management grant.
    await links("move", { ...original, libraryKey: "team" }, "bob");
    expect(await links("owner", original)).toBe("bob");
    expect(await links("admit", { ...original, libraryKey: "bob", name: undefined, version_id })).toEqual(original);
    await expect(links("admit", { ...original, libraryKey: "team", name: undefined, version_id })).rejects.toThrow("not found");
    await expect(links("admit", { ...original, name: undefined, version_id })).rejects.toThrow("not found");
    const stored = await runtime.unsafeGetDurableObjectStorage("ownership-test", "ArtifactLinks", { name: "deployment" });
    const rows = await stored.exec("select owner from library_ownership where workspace=? and kind=? and name=?", workspace, kind, name);
    expect(JSON.stringify(rows)).toContain("bob");
    expect(await links("owner", original)).toBe("bob");
    expect(await links("admit", { ...original, libraryKey: "bob" })).toEqual(original);
  });

  test(`${kind}: destination collisions and concurrent creation reservations never overwrite`, async () => {
    const workspace = `collision-${kind}`, name = "same", personal = { libraryKey: "alice", workspace, kind, name };
    for (const library of ["alice", "team"]) await call(binding, library, "writeDraft", { workspace, name, source: library });
    await expect(links("move", personal, "team")).rejects.toThrow("already in use");
    expect(await links("owner", personal)).toBe("alice");
    expect(await call(binding, "team", "readRange", { workspace, name })).toMatchObject({ source: kind === "artifact" ? "team\n" : "team" });
    const reserved = { ...personal, name: "reserved" };
    await call(binding, "alice", "writeDraft", { workspace, name: reserved.name, source: "keep" });
    await links("admit", { ...reserved, libraryKey: "team" }, true);
    await expect(links("move", reserved, "team")).rejects.toThrow("already in use");
    const free = { ...personal, name: "free" };
    await call(binding, "alice", "writeDraft", { workspace, name: free.name, source: "retained" });
    const concurrent = await Promise.allSettled([links("move", free, "team"), links("move", free, "bob")]);
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const owner = await links("owner", free);
    expect(["team", "bob"]).toContain(owner);
    const created = await links("admit", free, true);
    expect(created.libraryKey).not.toBe("alice");
    await call(binding, created.libraryKey, "writeDraft", { workspace, name: free.name, source: "fresh" });
    expect(await links("admit", free)).toEqual(created);
    expect(await links("admit", { ...free, libraryKey: owner })).toEqual(free);
    expect(await call(binding, "alice", "readRange", { workspace, name: free.name })).toMatchObject({ source: kind === "artifact" ? "retained\n" : "retained" });
    await expect(links("move", { ...free, libraryKey: owner }, "alice")).rejects.toThrow("already in use");
  });

  test(`${kind}: remixing a moved item reserves its destination in the current logical library`, async () => {
    const workspace = `remix-${kind}`, name = "original", original = { libraryKey: "alice", workspace, kind, name };
    await call(binding, "alice", "writeDraft", { workspace, name, source: "original" });
    await links("move", original, "team");
    const admitted = await links("admitRemix", { ...original, libraryKey: "team" }, "copy");
    expect(admitted).toEqual(original);
    await call(binding, admitted.libraryKey, "remix", { workspace, name, new_name: "copy", ...(kind === "artifact" ? { runtime: "test" } : {}) });
    expect(await links("admit", { ...original, libraryKey: "team", name: "copy" })).toEqual({ ...original, name: "copy" });
    await expect(links("admit", { ...original, name: "copy" })).rejects.toThrow("not found");
    const versions = await links("catalog", { libraryKey: "team", workspace, kind, name: "copy", method: "history" });
    expect(versions).toHaveLength(1);
    expect(await links("admit", { ...original, libraryKey: "team", name: undefined, version_id: versions[0].version_id })).toEqual({ ...original, name: "copy" });
    await expect(links("admitRemix", { ...original, libraryKey: "team" }, "copy")).rejects.toThrow("already in use");
  });

  test(`${kind}: catalog pagination merges moved items without disclosing unrelated versions`, async () => {
    const workspace = `catalog-${kind}`;
    for (let i = 0; i < 103; i++) {
      const name = `item-${String(i).padStart(3, "0")}`;
      const owner = i % 2 ? "team" : "alice";
      await call(binding, owner, "writeDraft", { workspace, name, source: String(i) });
      if (kind === "artifact") await call(binding, owner, "recordServe", { workspace, name, source: String(i), runtime: "test", mode: "live", initial_state: {} });
      if (owner === "alice") await links("move", { libraryKey: owner, workspace, kind, name }, "team");
    }
    await call(binding, "alice", "writeDraft", { workspace, name: "hidden", source: "private" });
    const first = await links("catalog", { libraryKey: "team", workspace, kind, method: "listDrafts" });
    const last = await links("catalog", { libraryKey: "team", workspace, kind, method: "listDrafts", offset: 100 });
    expect(first).toHaveLength(100); expect(last).toHaveLength(3);
    expect([...first, ...last].map(row => row.id)).toEqual(Array.from({ length: 103 }, (_, i) => `item-${String(i).padStart(3, "0")}`));
    const privateRows = await links("catalog", { libraryKey: "alice", workspace, kind, method: "listDrafts" });
    expect(privateRows.map((row: any) => row.id)).toEqual(["hidden"]);
    const historyFirst = await links("catalog", { libraryKey: "team", workspace, kind, method: "history" });
    const historyLast = await links("catalog", { libraryKey: "team", workspace, kind, method: "history", offset: 100 });
    expect(historyFirst).toHaveLength(100); expect(historyLast).toHaveLength(3);
    expect(new Set([...historyFirst, ...historyLast].map(row => row.version_id)).size).toBe(103);
    expect([...historyFirst, ...historyLast].map(row => row.name).sort()).toEqual(Array.from({ length: 103 }, (_, i) => `item-${String(i).padStart(3, "0")}`));
  }, 30_000);
}
