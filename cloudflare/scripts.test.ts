import {afterAll,beforeAll,expect,test} from "bun:test";
import {Miniflare, Response as MFResponse} from "miniflare";
let runtime: Miniflare;
beforeAll(async()=>{
  const build=await Bun.build({entrypoints:[new URL("./scripts-test-worker.ts",import.meta.url).pathname],target:"node",format:"esm",external:["cloudflare:workers"]});
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime=new Miniflare({cf:false,port:0,workers:[{config:{name:"scripts-test",type:"worker",compatibilityDate:"2026-09-06",compatibilityFlags:["nodejs_compat"],manifest:{mainModule:"test.js",modulesRoot:import.meta.dir,modules:{"test.js":{type:"esm",contents:await build.outputs[0]!.text()}}},env:{SCRIPTS:{type:"durable-object",worker:"scripts-test",exportName:"ScriptLibrary"},SCRIPT_BACKENDS:{type:"durable-object",worker:"scripts-test",exportName:"ScriptBackend"},LOADER:{type:"worker-loader"}},exports:{ScriptLibrary:{type:"durable-object",storage:"sqlite"},ScriptBackend:{type:"durable-object",storage:"sqlite"}}},dev:{outboundService:{type:"fetcher",handler:()=>new MFResponse("upstream success")}}}]});
  await runtime.ready;
});
afterAll(async()=>{await runtime?.dispose();});
async function call(method: string,input: unknown,library="alice") {
  const response=await runtime.dispatchFetch(`http://localhost/${method}?library=${library}`,{method:"POST",body:JSON.stringify(input)});
  const value=await response.json() as any;
  if (!response.ok) throw new Error(value.error);
  return value.result;
}
const identity={workspace:"default",name:"handler"};
test("versioned drafts, atomic edits, last valid activation, secrets and library isolation",async()=>{
  const first=await call("writeDraft",{...identity,source:"first source"});
  const firstActivation=await call("activate",{...identity,source_hash:first.source_hash,code:"valid-code"});
  const draft=await call("writeDraft",{...identity,source:"invalid draft"});
  expect((await call("active",identity)).code).toBe("valid-code");
  expect((await call("active",{...identity,hash:firstActivation.hash})).code).toBe("valid-code");
  await expect(call("active",{...identity,hash:"missing"})).rejects.toThrow("version not found");
  await expect(call("activate",{...identity,source_hash:first.source_hash,code:"stale-code"})).rejects.toThrow("changed during validation");
  await expect(call("editDraft",{...identity,edits:[{old_text:"invalid",new_text:"valid"},{old_text:"missing",new_text:"x"}]})).rejects.toThrow("no changes written");
  expect((await call("readRange",identity)).source).toBe("invalid draft");
  const history=await call("history",identity);
  expect(history).toHaveLength(2);
  await call("restore",{workspace:"default",id:history[1].id});
  expect((await call("readRange",identity)).source).toBe("first source");
  expect((await call("active",identity)).code).toBe("valid-code");
  await call("activate",{...identity,source_hash:first.source_hash,code:"new-valid-code"});
  expect((await call("active",identity)).code).toBe("new-valid-code");
  expect((await call("active",{...identity,hash:firstActivation.hash})).code).toBe("valid-code");
  await call("setSecret",{...identity,key:"TOKEN",value:"private-token"});
  expect(await call("secretNames",identity)).toEqual(["TOKEN"]);
  expect(JSON.stringify(await call("history",identity))).not.toContain("private-token");
  expect(JSON.stringify(await call("listDrafts",{}))).not.toContain("private-token");
  expect(await call("listDrafts",{},"bob")).toEqual([]);
  await expect(call("version",{workspace:"other",id:history[0].id})).rejects.toThrow("not found");
  await expect(call("setSecret",{...identity,key:"TOKEN",value:"x".repeat(4097)})).rejects.toThrow("4 KiB");
  await call("setSecret",{...identity,key:"TOKEN",value:null});
  expect(await call("secretNames",identity)).toEqual([]);
});
async function run(code: string,secrets: Record<string,string>={},library="runtime",body="raw\r\nbody") {
  return runtime.dispatchFetch(`http://localhost/run?library=${library}`,{method:"POST",body:JSON.stringify({code,secrets,body})});
}
test("native arbitrary HTTP responses, request fidelity, outbound requests, SQLite and code updates",async()=>{
  const code=`export default {async fetch(request,env,ctx) {
    env.sql.exec("create table if not exists count(n integer)");
    env.sql.exec("insert into count values (1)");
    return Response.json({url:request.url,method:request.method,header:request.headers.get("x-original"),body:await request.text(),count:env.sql.exec("select count(*) as n from count").one().n,upstream:await (await fetch("https://upstream.example/data")).text(),bindings:Object.keys(env).sort()},{status:201,headers:{"x-handler":"yes"}});
  }};`;
  const response=await run(code);
  expect(response.status).toBe(201);
  expect(response.headers.get("x-handler")).toBe("yes");
  expect(await response.json()).toMatchObject({url:"https://scripts.invalid/chosen/path?one=two",method:"POST",header:"yes",body:"raw\r\nbody",count:1,upstream:"upstream success",bindings:["secrets","sql"]});
  expect(await (await run(code.replace("status:201","status:202"))).json()).toMatchObject({count:2});
  expect(await (await run(code,{},"other-runtime")).json()).toMatchObject({count:1});
},30000);
test("secrets update and stay isolated; bounded console/error logs redact literal secret values",async()=>{
  const code=`export default {fetch(request,env) {console.log("token",env.secrets.TOKEN); for(let i=0;i<110;i++) console.info("log",i); console.error(env.secrets.TOKEN); return new Response(env.secrets.TOKEN);}};`;
  expect(await (await run(code,{TOKEN:"first-secret"},"secret-a")).text()).toBe("first-secret");
  expect(await (await run(code,{TOKEN:"second-secret"},"secret-a")).text()).toBe("second-secret");
  expect(await (await run(code,{TOKEN:"third-secret"},"secret-b")).text()).toBe("third-secret");
  const logs=await (await runtime.dispatchFetch("http://localhost/logs?library=secret-a")).json() as any[];
  expect(logs.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(logs)).not.toContain("first-secret");
  expect(JSON.stringify(logs)).not.toContain("second-secret");
  expect(JSON.stringify(logs)).toContain("[REDACTED]");
  const failure=await run(`export default {fetch(request,env) {throw new Error(env.secrets.TOKEN)}}`,{TOKEN:"hidden-error"},"errors");
  expect(failure.status).toBe(500);
  expect(await failure.text()).toBe("Script execution failed");
},30000);

test("module-load validation rejects broken initialization without replacing the live facet",async()=>{
  const code='export default {fetch(request,env) {env.sql.exec("create table if not exists preserved(n integer)"); env.sql.exec("insert into preserved values(1)"); return new Response(String(env.sql.exec("select count(*) as n from preserved").one().n));}}';
  expect(await (await run(code,{},"validation")).text()).toBe("1");
  const response=await runtime.dispatchFetch("http://localhost/validate?library=validation",{method:"POST",body:JSON.stringify({code:'throw new Error("broken"); export default {fetch(){return new Response("bad")}}',hash:"broken",secrets:{}})});
  expect(await response.json()).toMatchObject({ok:false,error:"Script module could not initialize"});
  expect(await (await run(code,{},"validation")).text()).toBe("2");
  const streaming=await run('export default {fetch(){return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("streamed"));c.close();}}),{headers:{"content-type":"text/plain"}})}}',{},"streaming");
  expect(await streaming.text()).toBe("streamed");
},30000);
