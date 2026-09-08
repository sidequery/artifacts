import { normalizeTiming, nextOccurrence, type ScheduleTiming } from "./schedule";
import { DurableObject } from "cloudflare:workers";
import type { ScriptLibrary } from "./scripts";
import type { ArtifactLinks } from "./links";
import { nativeRequest } from "./backend";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import { sha256 } from "./library";

export type ScriptLog = { timestamp: string; level: string; message: string; run_id?: string };
export type ScriptRequest = {code: string; hash: string; secrets: Record<string,string>; request: Request; trigger?: "http" | "manual" | "schedule"; run_id?: string};
export type ScheduleIdentity = {libraryKey: string; workspace: string; name: string; origin: string};
export type ScriptSchedule = ScheduleTiming & { paused: boolean; next_run_at: number | null; request: ArtifactHttpRequest};
export type ScriptRun = {id: string; revision: string; trigger: string; started_at: string; finished_at: string | null; duration_ms: number | null; status: string; http_status: number | null};
type Env = { LOADER: WorkerLoader; SCRIPTS: DurableObjectNamespace<ScriptLibrary>; LINKS: DurableObjectNamespace<ArtifactLinks> };
const runtimeConfig = { compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"], limits: { cpuMs: 30000, subRequests: 50 } };
declare abstract class ScriptFacet extends DurableObject { takeLogs(): ScriptLog[]; }
const RUN_HEADER = "x-artifact-internal-run";

// Each script has its own isolate and native SQLite facet. Only the explicit
// script secrets are supplied; the application's environment is never copied.
const logging = `import { AsyncLocalStorage } from "node:async_hooks";
const secrets = __ARTIFACTS_SCRIPT_SECRETS__;
export const execution = new AsyncLocalStorage();
let logs = [];
const clean = (value, secrets) => {
  let message;
  try { message = typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(value); } catch { message = "[unserializable]"; }
  message = String(message);
  for (const secret of Object.values(secrets)) if (secret) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 2048);
};
for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = (...args) => {
      logs.push({run_id: execution.getStore(), timestamp: new Date().toISOString(), level, message: args.slice(0, 16).map(value => clean(value, secrets)).join(" ").slice(0, 2048)});
      if (logs.length > 100) logs.shift();
};
export function takeLogs() { const result = logs; logs = []; return result; }
`;
const adapter = `import { DurableObject } from "cloudflare:workers";
import { takeLogs, execution } from "./logging.js";
import handler from "./user.js";
export class ScriptRuntime extends DurableObject {
  fetch(incoming) {
    const {id, original} = JSON.parse(incoming.headers.get("${RUN_HEADER}"));
    const request = new Request(incoming);
    if (original === null) request.headers.delete("${RUN_HEADER}");
    else request.headers.set("${RUN_HEADER}", original);
    return execution.run(id, () => this.handle(request));
  }
  async handle(request) {
    try {
      const response = await handler.fetch(request, {secrets: this.env.secrets, sql: this.ctx.storage.sql}, {
        waitUntil: promise => this.ctx.waitUntil(Promise.resolve(promise).catch(error => {console.error(error);})),
        passThroughOnException() {},
      });
      if (!(response instanceof Response)) throw new Error("Script handler must return a Response");
      return response;
    } catch (error) { console.error(error); return new Response("Script execution failed", {status: 500}); }
  }
  takeLogs() { return takeLogs(); }
}
export default { fetch() { return new Response(typeof handler?.fetch === "function" ? "ready" : "invalid", {status: typeof handler?.fetch === "function" ? 200 : 400}); } };
`;

export class ScriptBackend extends DurableObject<Env> {
  private activeKey?: string;
  private facet?: Fetcher<ScriptFacet>;
  constructor(state: DurableObjectState, env: Env) {
    super(state,env);
    state.storage.sql.exec("create table if not exists execution_logs(id integer primary key autoincrement,timestamp text not null,level text not null,message text not null)");
    if (!state.storage.sql.exec<{name: string}>("pragma table_info(execution_logs)").toArray().some(column => column.name === "run_id")) state.storage.sql.exec("alter table execution_logs add column run_id text");
    state.storage.sql.exec("create table if not exists execution_runs(id text primary key,revision text not null,trigger text not null,started_at text not null,finished_at text,duration_ms integer,status text not null,http_status integer)");
    // A previous instance may have performed side effects before it stopped.
    // Preserve uncertainty; never silently replay those invocations.
    state.storage.sql.exec("update execution_runs set status='interrupted' where status='running'");
  }
  private cacheKey(input: Omit<ScriptRequest,"request">) {
    return sha256(JSON.stringify([this.ctx.id.toString(), input.code, input.secrets, runtimeConfig, adapter, logging]));
  }
  private worker(input: Omit<ScriptRequest,"request">) {
    const hash=this.cacheKey(input);
    return this.env.LOADER.get(hash,async()=>({
      ...runtimeConfig,
      mainModule:"adapter.js",modules:{"adapter.js":adapter,"logging.js":logging.replace("__ARTIFACTS_SCRIPT_SECRETS__", () => JSON.stringify(input.secrets)),"user.js":input.code},
      env:{secrets:input.secrets},
    }));
  }
  /** Load the module before moving the live revision, without touching its SQLite facet. */
  async validate(input: Omit<ScriptRequest,"request">) {
    try {
      const response=await this.worker(input).getEntrypoint().fetch("https://script.invalid/validate");
      if (!response.ok) throw new Error("invalid handler");
      return {ok:true};
    } catch { return {ok:false,error:"Script module could not initialize"}; }
  }
  async request(input: ScriptRequest): Promise<Response> {
    // The namespace identity is deliberately part of the loader key: identical
    // scripts owned by different libraries must never share secrets or globals.
    const hash=this.cacheKey(input);
    if (this.activeKey!==hash) {
      if (this.facet) await this.collect(this.facet);
      this.ctx.facets.abort("script", "Script code or secrets updated");
      this.activeKey=hash;
    }
    const facet=this.ctx.facets.get<ScriptFacet>("script",()=> {
      const worker=this.worker(input);
      return {class:worker.getDurableObjectClass<ScriptFacet>("ScriptRuntime")};
    });
    this.facet=facet;
    const started=Date.now(), runId=input.run_id ?? crypto.randomUUID();
    this.ctx.storage.sql.exec("insert or ignore into execution_runs(id,revision,trigger,started_at,status) values(?,?,?,?,?)",runId,input.hash,input.trigger??"http",new Date(started).toISOString(),"running");
    try {
      // Use the native fetch bridge: celld's generic RPC cannot clone Request.
      // Restore the caller's header before user code sees the request.
      const request = new Request(input.request);
      request.headers.set(RUN_HEADER, JSON.stringify({ id: runId, original: request.headers.get(RUN_HEADER) }));
      const response=await facet.fetch(request);
      this.finish(runId,started,response.status);
      this.record({run_id:runId,timestamp:new Date().toISOString(),level:"request",message:`${input.request.method} ${response.status} ${Date.now()-started}ms`});
      await this.collect(facet);
      return response;
    } catch {
      this.finish(runId,started,500);
      this.record({run_id:runId,timestamp:new Date().toISOString(),level:"error",message:"Script execution failed"});
      return new Response("Script execution failed",{status:500});
    }
  }
  private finish(id: string, started: number, status: number) {
    this.ctx.storage.sql.exec("update execution_runs set finished_at=?,duration_ms=?,status=?,http_status=? where id=?",new Date().toISOString(),Date.now()-started,status>=400?"failed":"succeeded",status,id);
    this.ctx.storage.sql.exec("delete from execution_runs where status!='running' and id not in (select id from execution_runs order by started_at desc limit 1000)");
  }
  runs(input: {limit?: number} = {}) {
    const limit=input.limit??100;
    if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error("limit must be between 1 and 100");
    return this.ctx.storage.sql.exec<ScriptRun>("select * from execution_runs order by started_at desc,rowid desc limit ?",limit).toArray();
  }
  async schedule(input: {identity?: ScheduleIdentity; interval_seconds?: number; cron?: string; timezone?: string; request?: ArtifactHttpRequest; action?: "get"|"set"|"pause"|"resume"|"run_now"} = {}): Promise<ScriptSchedule|null> {
    const action=input.action??"get";
    if (!["get","set","pause","resume","run_now"].includes(action)) throw new Error("Unknown schedule action");
    if (action==="get") return await this.ctx.storage.get<ScriptSchedule>("schedule")??null;
    if (action==="run_now") { await this.runScheduled("manual"); return await this.schedule(); }
    let next: ScriptSchedule|null=null;
    await this.ctx.storage.transaction(async storage => {
    const previous=await storage.get<ScriptSchedule>("schedule");
    if (action!=="set" && !previous) throw new Error("No schedule configured");
    if (action==="set") {
      const timing=normalizeTiming(input);
      if (!input.identity) throw new Error("Schedule identity required");
      const request=input.request??{path:"/",method:"GET",headers:[]};
      nativeRequest(request); // Validate before persisting any state.
      next={...timing,request,paused:false,next_run_at:nextOccurrence(timing)};
    } else next={...previous!,paused:action==="pause",next_run_at:action==="pause"?null:nextOccurrence(previous!)};
      if (input.identity) await storage.put("schedule_identity",input.identity);
      await storage.put("schedule",next);
      if (next.next_run_at===null) await storage.deleteAlarm(); else await storage.setAlarm(next.next_run_at);
    });
    return next;
  }
  async alarm() {
    // Commit the next occurrence before invoking user code. Alarm redelivery
    // then sees a future timestamp and cannot replay this occurrence.
    let due: {id:string;started:number;schedule:ScriptSchedule}|undefined;
    await this.ctx.storage.transaction(async storage => {
      due=undefined;
      const schedule=await storage.get<ScriptSchedule>("schedule");
      if (!schedule || schedule.paused || schedule.next_run_at===null) return;
      if (schedule.next_run_at>Date.now()) { await storage.setAlarm(schedule.next_run_at); return; }
      const next=nextOccurrence(schedule);
      await storage.put("schedule",{...schedule,next_run_at:next});
      await storage.setAlarm(next);
      const id=crypto.randomUUID(),started=Date.now();
      this.ctx.storage.sql.exec("insert into execution_runs(id,revision,trigger,started_at,status) values(?,?,?,?,?)",id,"unavailable","schedule",new Date(started).toISOString(),"running");
      due={id,started,schedule};
    });
    if (due) await this.runScheduled("schedule",due);
  }
  private async runScheduled(trigger: "manual"|"schedule",claimed?:{id:string;started:number;schedule:ScriptSchedule}) {
    const schedule=claimed?.schedule??await this.ctx.storage.get<ScriptSchedule>("schedule");
    const identity=await this.ctx.storage.get<ScheduleIdentity>("schedule_identity");
    if (!schedule || !identity) throw new Error("No schedule configured");
    const id=claimed?.id??crypto.randomUUID(), started=claimed?.started??Date.now();
    this.ctx.storage.sql.exec("insert or ignore into execution_runs(id,revision,trigger,started_at,status) values(?,?,?,?,?)",id,"unavailable",trigger,new Date(started).toISOString(),"running");
    try {
      const {libraryKey,workspace,name,origin}=identity;
      const link=await this.env.LINKS.getByName("deployment").find({libraryKey,workspace,name,kind:"script"});
      if (!link?.script_hash) throw new Error("No active revision");
      const active=await this.env.SCRIPTS.getByName(libraryKey).active({workspace,name,hash:link.script_hash});
      this.ctx.storage.sql.exec("update execution_runs set revision=? where id=?",active.hash,id);
      const incoming=nativeRequest(schedule.request);
      const request=new Request(new URL(new URL(incoming.url).pathname+new URL(incoming.url).search,origin),incoming);
      const response=await this.request({...active,request,trigger,run_id:id});
      await response.body?.cancel();
    } catch {
      this.ctx.storage.sql.exec("insert or ignore into execution_runs(id,revision,trigger,started_at,status) values(?,?,?,?,?)",id,"unavailable",trigger,new Date(started).toISOString(),"running");
      this.finish(id,started,500);
      this.record({run_id:id,timestamp:new Date().toISOString(),level:"error",message:"Scheduled execution failed; inspect the active revision and its configuration"});
    }
  }
  private record(log: ScriptLog) {
    this.ctx.storage.sql.exec("insert into execution_logs(timestamp,level,message,run_id) values(?,?,?,?)",log.timestamp,log.level,log.message.slice(0,2048),log.run_id??null);
    this.ctx.storage.sql.exec("delete from execution_logs where id not in (select id from execution_logs order by id desc limit 100)");
  }
  private async collect(facet: Fetcher<ScriptFacet>) {
    try { for (const log of (await facet.takeLogs()).slice(-100)) this.record(log); } catch { /* An aborted isolate cannot supply pending logs. */ }
  }
  async logs(input: {limit?: number; run_id?: string} = {}) {
    const limit=input.limit??100;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error("limit must be between 1 and 100");
    if (this.facet) await this.collect(this.facet);
    return this.ctx.storage.sql.exec<ScriptLog>("select timestamp,level,message,run_id from execution_logs where (? is null or run_id=?) order by id desc limit ?",input.run_id??null,input.run_id??null,limit).toArray();
  }
}
