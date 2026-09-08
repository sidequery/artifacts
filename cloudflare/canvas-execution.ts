import type { CanvasHttpRequest } from "../src/httpTypes";
import { normalizeTiming, nextOccurrence, type ScheduleTiming } from "./schedule";

export type CanvasSchedule = ScheduleTiming & { paused: boolean; next_run_at: number | null; request: CanvasHttpRequest };
export type CanvasScheduleInput = ScheduleTiming & { action?: "get" | "set" | "pause" | "resume" | "run_now"; request?: CanvasHttpRequest };
export type CanvasRun = { id: string; revision: string; trigger: string; started_at: string; finished_at: string | null; duration_ms: number | null; status: string; http_status: number | null };
export type CanvasActive = { code: string | null; hash: string; version_id: string; revision: number };
export type CanvasClaim = { schedule: CanvasSchedule; active: CanvasActive | undefined; run: { id: string; started: number } };

/** Supervisor storage belongs to the host, separate from CanvasServer's facet. */
export class CanvasExecution {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec("create table if not exists host_schedule(id integer primary key check(id=1),payload text not null)");
    storage.sql.exec("create table if not exists active_server(id integer primary key check(id=1),payload text not null)");
    storage.sql.exec("create table if not exists execution_runs(id text primary key,revision text not null,trigger text not null,started_at text not null,finished_at text,duration_ms integer,status text not null,http_status integer)");
    storage.sql.exec("update execution_runs set status='interrupted' where status='running'");
  }
  async activate(active: CanvasActive) {
    await this.storage.transaction(async storage => {
      const previous = this.readActive();
      if (previous && previous.revision > active.revision) return;
      this.storage.sql.exec("insert into active_server(id,payload) values(1,?) on conflict(id) do update set payload=excluded.payload", JSON.stringify(active));
      if (active.code === null) {
        const schedule = this.readSchedule();
        if (schedule) this.writeSchedule({ ...schedule, paused: true, next_run_at: null });
        await storage.deleteAlarm();
      }
    });
  }
  private readActive(): CanvasActive | undefined {
    const row = this.storage.sql.exec<{ payload: string }>("select payload from active_server where id=1").toArray()[0];
    return row ? JSON.parse(row.payload) as CanvasActive : undefined;
  }
  async active() { return this.readActive(); }
  start(revision: string, trigger: string) {
    const id = crypto.randomUUID(), started = Date.now();
    this.storage.sql.exec("insert into execution_runs(id,revision,trigger,started_at,status) values(?,?,?,?,?)", id, revision, trigger, new Date(started).toISOString(), "running");
    return { id, started };
  }
  finish(run: { id: string; started: number }, status: number | null) {
    this.storage.sql.exec("update execution_runs set finished_at=?,duration_ms=?,status=?,http_status=? where id=?", new Date().toISOString(), Date.now() - run.started, status !== null && status < 400 ? "succeeded" : "failed", status, run.id);
    this.storage.sql.exec("delete from execution_runs where status!='running' and id not in (select id from execution_runs order by started_at desc,rowid desc limit 1000)");
  }
  runs(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    return this.storage.sql.exec<CanvasRun>("select * from execution_runs order by started_at desc,rowid desc limit ?", limit).toArray();
  }
  private readSchedule(): CanvasSchedule | null {
    const row = this.storage.sql.exec<{ payload: string }>("select payload from host_schedule where id=1").toArray()[0];
    return row ? JSON.parse(row.payload) as CanvasSchedule : null;
  }
  private writeSchedule(schedule: CanvasSchedule) {
    this.storage.sql.exec("insert into host_schedule(id,payload) values(1,?) on conflict(id) do update set payload=excluded.payload", JSON.stringify(schedule));
  }
  async get() { return this.readSchedule(); }
  async update(input: CanvasScheduleInput) {
    const action = input.action ?? "get";
    if (action === "get") return this.get();
    if (!["set", "pause", "resume"].includes(action)) throw new Error("Invalid schedule action");
    return this.storage.transaction(async storage => {
      const previous = this.readSchedule();
      if (action !== "set" && !previous) throw new Error("No schedule configured");
      const active = this.readActive();
      if (action !== "pause" && !active?.code) throw new Error("Canvas has no validated server");
      const timing = action === "set" ? normalizeTiming(input) : previous!;
      const request = action === "set" ? input.request ?? { path: "/", method: "GET", headers: [] } : previous!.request;
      const result: CanvasSchedule = { ...normalizeTiming(timing), request, paused: action === "pause", next_run_at: action === "pause" ? null : nextOccurrence(timing) };
      this.writeSchedule(result);
      if (result.next_run_at === null) await storage.deleteAlarm(); else await storage.setAlarm(result.next_run_at);
      return result;
    });
  }
  /** Claim before invoking; redelivered alarms cannot repeat side effects. */
  async claim(): Promise<CanvasClaim | null> {
    return this.storage.transaction(async storage => {
      const schedule = this.readSchedule();
      if (!schedule || schedule.paused || schedule.next_run_at === null) return null;
      if (schedule.next_run_at > Date.now()) { await storage.setAlarm(schedule.next_run_at); return null; }
      const next = nextOccurrence(schedule);
      this.writeSchedule({ ...schedule, next_run_at: next });
      await storage.setAlarm(next);
      const active = this.readActive();
      const run = this.start(active?.version_id ?? "unavailable", "schedule");
      return { schedule, active, run };
    });
  }
}
