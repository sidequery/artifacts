import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ArtifactExecution } from "./artifact-execution";

// Real SQLite for host history; the KV/alarm adapter exposes observable state
// without requiring a Workers isolate for scheduling state transitions.
function fixture() {
  const db = new Database(":memory:");
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    sql: { exec(query: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(query).all(...params);
      return { toArray: () => rows };
    } },
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    setAlarm: async (time: number) => { alarm = time; },
    deleteAlarm: async () => { alarm = null; },
    transaction: async (callback: (storage: unknown) => Promise<unknown>) => callback(storage),
  };
  return { execution: new ArtifactExecution(storage as unknown as DurableObjectStorage), storage, alarm: () => alarm, db };
}
const now = spyOn(Date, "now");
afterEach(() => now.mockReset());
afterAll(() => now.mockRestore());
const active = { code: "server", hash: "hash", version_id: "revision-one", revision: 1 };
const request = { path: "/refresh", method: "POST", headers: [] as [string, string][] };

test("schedule claims once, pause cancels alarm, resume schedules a future occurrence", async () => {
  now.mockReturnValue(1_800_000_000_000);
  const { execution, alarm } = fixture();
  await execution.activate(active);
  const saved = await execution.update({ action: "set", interval_seconds: 60, request });
  expect(saved).toMatchObject({ request, paused: false, next_run_at: Date.now() + 60_000 });
  expect(alarm()).toBe(saved.next_run_at);
  expect(await execution.claim()).toBeNull();
  now.mockReturnValue(saved.next_run_at!);
  expect(await execution.claim()).toMatchObject({ schedule: saved, active });
  expect(await execution.claim()).toBeNull();
  expect(alarm()).toBe(Date.now() + 60_000);
  await execution.update({ action: "pause" });
  expect(alarm()).toBeNull();
  expect(await execution.claim()).toBeNull();
  expect(await execution.update({ action: "resume" })).toMatchObject({ paused: false, next_run_at: Date.now() + 60_000 });
});

test("a claimed occurrence survives interruption without being replayed", async () => {
  now.mockReturnValue(1_800_000_000_000);
  const { execution, storage } = fixture();
  await execution.activate(active);
  const schedule = await execution.update({ action: "set", interval_seconds: 60, request });
  now.mockReturnValue(schedule.next_run_at!);
  const claimed = await execution.claim();
  expect(claimed).not.toBeNull();
  expect(execution.runs()).toMatchObject([{ id: claimed!.run.id, revision: active.version_id, status: "running", trigger: "schedule" }]);
  const restarted = new ArtifactExecution(storage as unknown as DurableObjectStorage);
  expect(await restarted.claim()).toBeNull();
  expect(restarted.runs()).toMatchObject([{ id: claimed!.run.id, status: "interrupted" }]);
});

test("validated activation is monotonic and server removal pauses scheduling", async () => {
  now.mockReturnValue(1_800_000_000_000);
  const { execution, alarm } = fixture();
  await execution.activate({ ...active, revision: 3, version_id: "revision-three" });
  await execution.activate(active);
  expect((await execution.active())?.version_id).toBe("revision-three");
  await execution.update({ action: "set", interval_seconds: 60, request });
  await execution.activate({ ...active, code: null, revision: 4 });
  expect(await execution.get()).toMatchObject({ paused: true, next_run_at: null });
  expect(alarm()).toBeNull();
  await expect(execution.update({ action: "resume" })).rejects.toThrow("no validated server");
});

test("invalid schedule cannot replace existing state, cron uses configured timezone", async () => {
  now.mockReturnValue(Date.parse("2026-09-07T10:00:00Z"));
  const { execution } = fixture();
  await execution.activate(active);
  const saved = await execution.update({ action: "set", cron: "0 9 * * *", timezone: "America/Los_Angeles", request });
  expect(saved.next_run_at).toBe(Date.parse("2026-09-07T16:00:00Z"));
  await expect(execution.update({ action: "set", interval_seconds: 5, request })).rejects.toThrow();
  await expect(execution.update({ action: "set", interval_seconds: 60, cron: "* * * * *", request })).rejects.toThrow();
  expect(await execution.get()).toEqual(saved);
});

test("history records revision, trigger, duration and failures; restart retains uncertainty", () => {
  now.mockReturnValue(1_800_000_000_000);
  const { execution, storage } = fixture();
  const run = execution.start("version-1", "schedule");
  now.mockReturnValue(Date.now() + 123);
  execution.finish(run, 204);
  expect(execution.runs()).toMatchObject([{ revision: "version-1", trigger: "schedule", duration_ms: 123, status: "succeeded", http_status: 204 }]);
  const failed = execution.start("version-2", "http");
  execution.finish(failed, 500);
  const uncertain = execution.start("version-3", "manual");
  const recovered = new ArtifactExecution(storage as unknown as DurableObjectStorage);
  expect(recovered.runs().find(run => run.id === uncertain.id)).toMatchObject({ status: "interrupted", finished_at: null });
  expect(recovered.runs().find(run => run.id === failed.id)).toMatchObject({ status: "failed", http_status: 500 });
  expect(() => recovered.runs(101)).toThrow();
});

test("compiled source and scheduled bodies larger than KV values persist in host SQLite", async () => {
  now.mockReturnValue(1_800_000_000_000);
  const { execution, storage } = fixture();
  const source = "x".repeat(200_000), body = btoa("y".repeat(200_000));
  await execution.activate({ ...active, code: source });
  await execution.update({ action: "set", interval_seconds: 3600, request: { ...request, body } });
  const restarted = new ArtifactExecution(storage as unknown as DurableObjectStorage);
  expect((await restarted.active())?.code).toBe(source);
  expect((await restarted.get())?.request.body).toBe(body);
});
