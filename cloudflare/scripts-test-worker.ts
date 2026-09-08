export { ScriptLibrary } from "./scripts";
import { ScriptBackend as BaseScriptBackend, type ScriptSchedule } from "./script-backend";
export {ArtifactLinks} from "./links";
import type {ArtifactLinks} from "./links";
export class ScriptBackend extends BaseScriptBackend {
  async repeatAlarm() { await this.alarm(); }
  async due() { const schedule=await this.ctx.storage.get<ScriptSchedule>("schedule"); await this.ctx.storage.put("schedule",{...schedule,next_run_at:Date.now()}); await this.ctx.storage.setAlarm(Date.now()+10); }
}
import type { ScriptLibrary } from "./scripts";

type Env = { LINKS: DurableObjectNamespace<ArtifactLinks>; SCRIPTS: DurableObjectNamespace<ScriptLibrary>; SCRIPT_BACKENDS: DurableObjectNamespace<ScriptBackend> };
export default { async fetch(request: Request, env: Env) {
  const url = new URL(request.url), name=url.searchParams.get("library")??"alice";
  if (url.pathname==="/run") {
    const input=await request.json() as {code: string; secrets: Record<string,string>; body?: string; method?: string};
    const response = await env.SCRIPT_BACKENDS.getByName(name).request({code:input.code,hash:"unused",secrets:input.secrets,origin:"https://scripts.invalid",request:{path:"/chosen/path?one=two",method:input.method??"POST",headers:[["x-original","yes"]],body:btoa(input.body??"original body")}});
    return new Response(response.body === undefined ? null : Uint8Array.from(atob(response.body), char => char.charCodeAt(0)), response);
  }
  if (url.pathname.startsWith("/backend/")) { try {const stub=env.SCRIPT_BACKENDS.getByName(name) as unknown as Record<string,(input:unknown)=>Promise<unknown>>;return Response.json({result:await stub[url.pathname.slice(9)]!(await request.json())});}catch(e){return Response.json({error:String(e)},{status:400});} }
  if (url.pathname==="/link") {const input=await request.json() as {hash:string};const links=env.LINKS.getByName("deployment");const target={libraryKey:name,workspace:"default",name:"handler",kind:"script" as const};const generation=await links.begin(target);return Response.json({result:await links.commit(target,generation,{slug:name,access:"private",script_hash:input.hash})});}
  if (url.pathname==="/logs") return Response.json(await env.SCRIPT_BACKENDS.getByName(name).logs({}));
  if (url.pathname==="/validate") return Response.json(await env.SCRIPT_BACKENDS.getByName(name).validate(await request.json()));
  try {
    const method=url.pathname.slice(1);
    const stub=env.SCRIPTS.getByName(name) as unknown as Record<string,(input: unknown)=>Promise<unknown>>;
    return Response.json({result:await stub[method]!(await request.json())});
  } catch(error) {return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
} };
