import { DurableObject } from "cloudflare:workers";
import { sha256 } from "./library";

export type ScriptLog = { timestamp: string; level: string; message: string };
export type ScriptRequest = {code: string; hash: string; secrets: Record<string,string>; request: Request};
type Env = { LOADER: WorkerLoader };
const runtimeConfig = { compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"], limits: { cpuMs: 30000, subRequests: 50 } };
declare abstract class ScriptFacet extends DurableObject { takeLogs(): ScriptLog[]; }

// Each script has its own isolate and native SQLite facet. Only the explicit
// script secrets are supplied; the application's environment is never copied.
const logging = `import { env } from "cloudflare:workers";
let logs = [];
const clean = (value, secrets) => {
  let message;
  try { message = typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(value); } catch { message = "[unserializable]"; }
  message = String(message);
  for (const secret of Object.values(secrets)) if (secret) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 2048);
};
for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = (...args) => {
      logs.push({timestamp: new Date().toISOString(), level, message: args.slice(0, 16).map(value => clean(value, env.secrets)).join(" ").slice(0, 2048)});
      if (logs.length > 100) logs.shift();
};
export function takeLogs() { const result = logs; logs = []; return result; }
`;
const adapter = `import { DurableObject } from "cloudflare:workers";
import { takeLogs } from "./logging.js";
import handler from "./user.js";
export class ScriptRuntime extends DurableObject {
  async fetch(request) {
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
  }
  private cacheKey(input: Omit<ScriptRequest,"request">) {
    return sha256(JSON.stringify([this.ctx.id.toString(), input.code, input.secrets, runtimeConfig, adapter, logging]));
  }
  private worker(input: Omit<ScriptRequest,"request">) {
    const hash=this.cacheKey(input);
    return this.env.LOADER.get(hash,async()=>({
      ...runtimeConfig,
      mainModule:"adapter.js",modules:{"adapter.js":adapter,"logging.js":logging,"user.js":input.code},
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
    const started=Date.now();
    try {
      const response=await facet.fetch(input.request);
      this.record({timestamp:new Date().toISOString(),level:"request",message:`${input.request.method} ${response.status} ${Date.now()-started}ms`});
      await this.collect(facet);
      return response;
    } catch {
      this.record({timestamp:new Date().toISOString(),level:"error",message:"Script execution failed"});
      return new Response("Script execution failed",{status:500});
    }
  }
  private record(log: ScriptLog) {
    this.ctx.storage.sql.exec("insert into execution_logs(timestamp,level,message) values(?,?,?)",log.timestamp,log.level,log.message.slice(0,2048));
    this.ctx.storage.sql.exec("delete from execution_logs where id not in (select id from execution_logs order by id desc limit 100)");
  }
  private async collect(facet: Fetcher<ScriptFacet>) {
    try { for (const log of (await facet.takeLogs()).slice(-100)) this.record(log); } catch { /* An aborted isolate cannot supply pending logs. */ }
  }
  async logs(input: {limit?: number} = {}) {
    const limit=input.limit??100;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error("limit must be between 1 and 100");
    if (this.facet) await this.collect(this.facet);
    return this.ctx.storage.sql.exec<ScriptLog>("select timestamp,level,message from execution_logs order by id desc limit ?",limit).toArray();
  }
}
