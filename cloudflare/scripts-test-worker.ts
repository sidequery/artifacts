export { ScriptLibrary } from "./scripts";
export { ScriptBackend } from "./script-backend";
import type { ScriptLibrary } from "./scripts";
import type { ScriptBackend } from "./script-backend";
type Env = { SCRIPTS: DurableObjectNamespace<ScriptLibrary>; SCRIPT_BACKENDS: DurableObjectNamespace<ScriptBackend> };
export default { async fetch(request: Request, env: Env) {
  const url = new URL(request.url), name=url.searchParams.get("library")??"alice";
  if (url.pathname==="/run") {
    const input=await request.json() as {code: string; secrets: Record<string,string>; body?: string; method?: string};
    return env.SCRIPT_BACKENDS.getByName(name).request({code:input.code,hash:"unused",secrets:input.secrets,request:new Request("https://scripts.invalid/chosen/path?one=two",{method:input.method??"POST",headers:{"x-original":"yes"},body:input.body??"original body"})});
  }
  if (url.pathname==="/logs") return Response.json(await env.SCRIPT_BACKENDS.getByName(name).logs({}));
  if (url.pathname==="/validate") return Response.json(await env.SCRIPT_BACKENDS.getByName(name).validate(await request.json()));
  try {
    const method=url.pathname.slice(1);
    const stub=env.SCRIPTS.getByName(name) as unknown as Record<string,(input: unknown)=>Promise<unknown>>;
    return Response.json({result:await stub[method]!(await request.json())});
  } catch(error) {return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
} };
