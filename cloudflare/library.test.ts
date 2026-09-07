import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";

let runtime: Miniflare;

type CallResult<T> = { result?: T; error?: string };
type DraftResult = {
  ok: boolean; workspace: string; name: string; source: string; source_hash: string;
  state: Record<string, unknown>; path: string;
};
type VersionResult = {
  version: { id: string; revision: number; source: string; workspace: string; name: string };
  event: { id: string; version_id: string; mode: string; initial_state: string };
};

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./library-test-worker.ts", import.meta.url).pathname],
    target: "node", format: "esm", external: ["cloudflare:workers"],
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const worker = await build.outputs[0]!.text();
  runtime = new Miniflare({
    cf: false, port: 0,
    workers: [{
      config: {
        name: "canvas-library-test", type: "worker", compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "library-test-worker.js", modulesRoot: import.meta.dir,
          modules: { "library-test-worker.js": { type: "esm", contents: worker } },
        },
        env: { LIBRARY: { type: "durable-object", worker: "canvas-library-test", exportName: "CanvasLibrary" } },
        exports: { CanvasLibrary: { type: "durable-object", storage: "sqlite" } },
      },
      dev: {},
    }],
  });
  await runtime.ready;
}, 30_000);

afterAll(async () => { await runtime?.dispose(); });

async function call<T>(method: string, input: unknown, library = "alice"): Promise<T> {
  const response = await runtime.dispatchFetch(`http://localhost/call/${method}?library=${encodeURIComponent(library)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const payload = await response.json() as CallResult<T>;
  if (!response.ok) throw new Error(payload.error ?? `call failed (${response.status})`);
  return payload.result as T;
}

async function fails(method: string, input: unknown, expected: string, library = "alice") {
  const response = await runtime.dispatchFetch(`http://localhost/call/${method}?library=${encodeURIComponent(library)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(400);
  expect((await response.json() as CallResult<never>).error).toContain(expected);
}

test("drafts preserve exact line endings, normalize names, hash the full source, and isolate libraries and workspaces", async () => {
  const source = Array.from({ length: 205 }, (_, i) => `line ${i + 1}\r\n`).join("");
  const written = await call<DraftResult>("writeDraft", { workspace: "north", name: "overview.canvas.tsx", source });
  expect(written).toMatchObject({ workspace: "north", name: "overview", source, state: {} });
  expect(written.source_hash).toBe(createHash("sha256").update(source).digest("hex"));

  const first = await call<Record<string, unknown>>("readRange", { workspace: "north", name: "overview" });
  expect(first).toMatchObject({ total_lines: 205, start_line: 1, end_line: 200, next_line: 201 });
  expect(first.source).toBe(source.split(/(?<=\n)/).slice(0, 200).join(""));
  const last = await call<Record<string, unknown>>("readRange", { workspace: "north", name: "overview", start_line: 201 });
  expect(last.source).toBe(source.split(/(?<=\n)/).slice(200).join(""));

  const unicode = "const label = 'Café 🐑 東京';\r\n";
  const unicodeWritten = await call<DraftResult>("writeDraft", { workspace: "north", name: "overview", source: unicode });
  expect(unicodeWritten.source_hash).toBe(createHash("sha256").update(unicode).digest("hex"));

  const newline = await call<DraftResult>("writeDraft", { workspace: "south", name: "plain", source: "one line" });
  expect(newline.source).toBe("one line\n");
  await call("writeDraft", { workspace: "north", name: "other", source: "same library" }, "bob");
  expect(await call("listDrafts", {})).toHaveLength(2);
  expect(await call("listDrafts", { workspace: "north" })).toHaveLength(1);
  expect(await call("listDrafts", {}, "bob")).toHaveLength(1);
  for (const name of ["../escape", "dir/file", "dir\\file", ".canvas.tsx"]) {
    await fails("writeDraft", { workspace: "north", name, source: "bad" }, "canvas name");
  }
  await fails("writeDraft", { workspace: "north", name: "é".repeat(123), source: "bad" }, "255 bytes");
});

test("edits are sequential, guarded, exact, and atomic on every failure", async () => {
  const initial = await call<DraftResult>("writeDraft", { workspace: "edits", name: "overview", source: "alpha beta beta\ngamma\n" });
  const edited = await call<DraftResult & { changed: boolean; applied: boolean; edits_applied: number }>("editDraft", {
    workspace: "edits", name: "overview", expected_hash: initial.source_hash,
    edits: [{ old_text: "alpha", new_text: "first" }, { old_text: "beta beta", new_text: "second" }, { old_text: "gamma", new_text: "" }],
  });
  expect(edited).toMatchObject({ applied: true, changed: true, edits_applied: 3, source: "first second\n\n" });
  const stable = edited.source;
  await fails("editDraft", { workspace: "edits", name: "overview", expected_hash: initial.source_hash, edits: [{ old_text: "first", new_text: "stale" }] }, "changed since read");
  await fails("editDraft", { workspace: "edits", name: "overview", edits: [{ old_text: "first", new_text: "changed" }, { old_text: "missing", new_text: "x" }] }, "no changes written");
  expect((await call<DraftResult>("readRange", { workspace: "edits", name: "overview" })).source).toBe(stable);

  await call("writeDraft", { workspace: "edits", name: "ambiguous", source: "repeat repeat" });
  await fails("editDraft", { workspace: "edits", name: "ambiguous", edits: [{ old_text: "repeat", new_text: "one" }] }, "ambiguous");
  expect((await call<DraftResult>("readRange", { workspace: "edits", name: "ambiguous" })).source).toBe("repeat repeat\n");

  const deletable = await call<DraftResult>("writeDraft", { workspace: "edits", name: "empty", source: "delete all" });
  await call("editDraft", { workspace: "edits", name: "empty", expected_hash: deletable.source_hash, edits: [{ old_text: "delete all\n", new_text: "" }] });
  expect(await call("readRange", { workspace: "edits", name: "empty" })).toMatchObject({
    source: "", total_lines: 1, start_line: 1, end_line: 1, next_line: null,
  });
});

test("successful serve snapshots deduplicate versions while retaining UUID events and archived selection", async () => {
  const source = "export default function Canvas() { return null; }\n";
  await call("writeDraft", { workspace: "history", name: "overview", source });
  const first = await call<VersionResult>("recordServe", { workspace: "history", name: "overview", source, runtime: "sdk-a", initial_state: { count: 1 }, mode: "live" });
  const second = await call<VersionResult>("recordServe", { workspace: "history", name: "overview", source, runtime: "sdk-a", initial_state: { count: 2 }, mode: "live" });
  expect(second.version.id).toBe(first.version.id);
  expect(second.event.id).not.toBe(first.event.id);
  expect(first.version.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await call<unknown[]>("history", { workspace: "history" })).toHaveLength(1);
  expect(await call<unknown[]>("events", { workspace: "history", version_id: first.version.id })).toHaveLength(2);

  const changed = source.replace("null", "<div />");
  const newer = await call<VersionResult>("recordServe", { workspace: "history", name: "overview", source: changed, runtime: "sdk-b", initial_state: { count: 3 }, mode: "live" });
  expect(newer.version.revision).toBe(2);
  const replay = await call<VersionResult>("recordServe", { workspace: "history", name: "overview", source, version_id: first.version.id, runtime: "sdk-b", initial_state: { count: 99 }, mode: "replay" });
  expect(replay.version.id).toBe(first.version.id);
  expect(await call<unknown[]>("history", { workspace: "history" })).toHaveLength(2);
  await fails("recordServe", { workspace: "history", name: "overview", source: changed, version_id: first.version.id, runtime: "sdk-b", initial_state: {}, mode: "replay" }, "does not match");

  const automatic = await call<{ state: { count: number } }>("preview", { workspace: "history", version_id: first.version.id });
  expect(automatic.state.count).toBe(2);
  const selected = await call<{ state: { count: number } }>("preview", { workspace: "history", version_id: first.version.id, event_id: replay.event.id });
  expect(selected.state.count).toBe(99);
  await fails("version", { workspace: "elsewhere", id: first.version.id }, "not found in this workspace");
  await fails("events", { workspace: "elsewhere", version_id: first.version.id }, "not found in this workspace");
});

test("restore preserves the current draft, links a forced revision, and retains working UI state", async () => {
  const original = "export default function Canvas() { return <p>original</p>; }\n";
  await call("writeDraft", { workspace: "restore", name: "overview", source: original });
  await call("setState", { workspace: "restore", name: "overview", key: "count", value: 9 });
  const served = await call<VersionResult>("recordServe", { workspace: "restore", name: "overview", source: original, runtime: "sdk-a", initial_state: { count: 4 }, mode: "live" });
  const invalid = "export default function ( unfinished\n";
  await call("writeDraft", { workspace: "restore", name: "overview", source: invalid });

  const restored = await call<DraftResult & { restored: boolean; versionId: string; revision: number }>("restore", { workspace: "restore", id: served.version.id, runtime: "sdk-b" });
  expect(restored).toMatchObject({ restored: true, source: original, state: { count: 9 }, revision: 3 });
  const history = await call<Array<{ version_id: string; reason: string; restored_from: string | null }>>("history", { workspace: "restore", name: "overview" });
  expect(history.map(row => row.reason)).toEqual(["restore", "before-restore", "served"]);
  expect(history[0]?.restored_from).toBe(served.version.id);
  const preserved = await call<{ source: string }>("version", { workspace: "restore", id: history[1]!.version_id });
  expect(preserved.source).toBe(invalid);
  expect((await call<{ state: { count: number } }>("preview", { workspace: "restore", name: "overview" })).state.count).toBe(9);
  expect(await call<unknown[]>("events", { workspace: "restore", version_id: served.version.id })).toHaveLength(1);
});

test("concurrent source captures allocate complete monotonic revisions", async () => {
  const captures = await Promise.all(Array.from({ length: 12 }, (_, index) => call<VersionResult>("recordServe", {
    workspace: "concurrent", name: "overview", source: `revision ${index}\n`, runtime: "sdk", initial_state: { index }, mode: "live",
  })));
  expect(new Set(captures.map(item => item.version.id)).size).toBe(12);
  const history = await call<Array<{ revision: number; serve_count: number }>>("history", { workspace: "concurrent" });
  expect(history.map(item => item.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  expect(history.every(item => item.serve_count === 1)).toBe(true);
});

test("draft and history pagination is bounded, deterministic, scoped, and reaches older rows", async () => {
  for (let index = 0; index < 105; index++) {
    await call("writeDraft", { workspace: "page-drafts", name: `draft-${String(index).padStart(3, "0")}`, source: `draft ${index}` });
  }
  await call("writeDraft", { workspace: "page-drafts-other", name: "private", source: "other workspace" });
  const draftsFirst = await call<Array<{ id: string; workspace: string }>>("listDrafts", { workspace: "page-drafts" });
  const draftsLast = await call<Array<{ id: string; workspace: string }>>("listDrafts", { workspace: "page-drafts", offset: 100 });
  expect(draftsFirst).toHaveLength(100);
  expect(draftsFirst[0]?.id).toBe("draft-000");
  expect(draftsFirst[99]?.id).toBe("draft-099");
  expect(draftsLast.map(item => item.id)).toEqual(["draft-100", "draft-101", "draft-102", "draft-103", "draft-104"]);
  expect([...draftsFirst, ...draftsLast].every(item => item.workspace === "page-drafts")).toBe(true);

  for (let revision = 1; revision <= 105; revision++) {
    await call("recordServe", { workspace: "page-history", name: "overview", source: `revision ${revision}\n`, runtime: "sdk", initial_state: {}, mode: "live" });
  }
  await call("recordServe", { workspace: "page-history-other", name: "overview", source: "private\n", runtime: "sdk", initial_state: {}, mode: "live" });
  const historyFirst = await call<Array<{ revision: number; workspace: string }>>("history", { workspace: "page-history" });
  const historyLast = await call<Array<{ revision: number; workspace: string }>>("history", { workspace: "page-history", offset: 100 });
  expect(historyFirst).toHaveLength(100);
  expect(historyFirst[0]?.revision).toBe(105);
  expect(historyFirst[99]?.revision).toBe(6);
  expect(historyLast.map(item => item.revision)).toEqual([5, 4, 3, 2, 1]);
  expect([...historyFirst, ...historyLast].every(item => item.workspace === "page-history")).toBe(true);

  for (const input of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
    await fails("listDrafts", { workspace: "page-drafts", ...input }, input.offset !== undefined ? "offset" : "limit");
    await fails("history", { workspace: "page-history", ...input }, input.offset !== undefined ? "offset" : "limit");
  }
});

test("event pagination defaults to 20 and version exposes a stable continuation offset", async () => {
  const source = "event source\n";
  let versionId = "";
  for (let index = 0; index < 25; index++) {
    const served = await call<VersionResult>("recordServe", {
      workspace: "page-events", name: "overview", source, runtime: "sdk", initial_state: { index }, mode: "live",
    });
    versionId = served.version.id;
  }
  const first = await call<Array<{ initial_state: string }>>("events", { workspace: "page-events", version_id: versionId });
  const older = await call<Array<{ initial_state: string }>>("events", { workspace: "page-events", version_id: versionId, offset: 20 });
  expect(first).toHaveLength(20);
  expect(first.map(event => JSON.parse(event.initial_state).index)).toEqual(Array.from({ length: 20 }, (_, index) => 24 - index));
  expect(older).toHaveLength(5);
  expect(older.map(event => JSON.parse(event.initial_state).index)).toEqual([4, 3, 2, 1, 0]);

  const current = await call<{ events: unknown[]; events_offset: number; next_events_offset: number | null }>("version", { workspace: "page-events", id: versionId });
  const continued = await call<{ events: unknown[]; events_offset: number; next_events_offset: number | null }>("version", { workspace: "page-events", id: versionId, events_offset: 20 });
  expect(current).toMatchObject({ events_offset: 0, next_events_offset: 20 });
  expect(current.events).toHaveLength(20);
  expect(continued).toMatchObject({ events_offset: 20, next_events_offset: null });
  expect(continued.events).toHaveLength(5);

  for (const input of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 21 }, { limit: 1.5 }]) {
    await fails("events", { workspace: "page-events", version_id: versionId, ...input }, input.offset !== undefined ? "offset" : "limit");
  }
  await fails("version", { workspace: "page-events", id: versionId, events_offset: -1 }, "offset");
});

test("source and serialized state are bounded for drafts, edits, serves, and UI state", async () => {
  await fails("writeDraft", { workspace: "limits", name: "large", source: "x".repeat(256 * 1024 + 1) }, "256 KiB");
  const source = "x".repeat(256 * 1024 - 1) + "\n";
  await call("writeDraft", { workspace: "limits", name: "edge", source });
  await fails("editDraft", { workspace: "limits", name: "edge", edits: [{ old_text: source, new_text: `${source}x` }] }, "256 KiB");
  expect((await call<DraftResult>("readRange", { workspace: "limits", name: "edge", start_line: 1 })).source.length).toBe(256 * 1024);
  await fails("recordServe", { workspace: "limits", name: "edge", source: "x".repeat(256 * 1024 + 1), runtime: "sdk", initial_state: {}, mode: "live" }, "256 KiB");
  await fails("setState", { workspace: "limits", name: "edge", key: "large", value: "x".repeat(64 * 1024) }, "64 KiB");
  await fails("recordServe", { workspace: "limits", name: "edge", source: "ok", runtime: "sdk", initial_state: { large: "x".repeat(64 * 1024) }, mode: "live" }, "64 KiB");
});
