import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ensureCelldRuntime} from "../src/local/celld-runtime";
const enabled=process.env.CELLD_SCHEDULING_INTEGRATION==="1";
let directory="",url="",binary="",logs="";
let child:ReturnType<typeof Bun.spawn>|undefined;
async function start(){
  child=Bun.spawn([binary,"dev",directory,"--host","127.0.0.1","--port",new URL(url).port,"--no-watch"],{cwd:directory,env:{...process.env,CELLD_WORKER_LOADER:"LOADER",CELLD_ESBUILD:join(import.meta.dir,"../node_modules/.bin/esbuild")},stdout:"pipe",stderr:"pipe"});
  for(const stream of [child.stdout,child.stderr]) if(typeof stream!=="number")void(async()=>{for await(const chunk of stream)logs+=new TextDecoder().decode(chunk);})();
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){try{if((await fetch(url+"/logs")).ok)return;}catch{}if(child.exitCode!==null)break;await Bun.sleep(100);}
  throw new Error("celld did not start: "+logs);
}
async function stop(){if(!child||child.exitCode!==null)return;child.kill("SIGINT");await child.exited;child=undefined;}
beforeAll(async()=>{
  if(!enabled)return;
  directory=await mkdtemp(join(tmpdir(),"canvas-schedule-celld-"));
  binary=process.env.CELLD_BIN??await ensureCelldRuntime({dataRoot:join(directory,"runtime")});
  const listener=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});url=`http://127.0.0.1:${listener.port}`;listener.stop(true);
  const bundle=await Bun.build({entrypoints:[join(import.meta.dir,"scripts-test-worker.ts")],target:"browser",format:"esm",external:["cloudflare:workers","node:*","fs","fs/promises"]});
  if(!bundle.success)throw new Error(bundle.logs.join("\n"));
  await Bun.write(join(directory,"worker.js"),await bundle.outputs[0]!.text());
  await Bun.write(join(directory,"wrangler.jsonc"),JSON.stringify({name:"schedule-test",main:"worker.js",compatibility_date:"2026-09-06",compatibility_flags:["nodejs_compat"],durable_objects:{bindings:[{name:"SCRIPTS",class_name:"ScriptLibrary"},{name:"SCRIPT_BACKENDS",class_name:"ScriptBackend"},{name:"LINKS",class_name:"ArtifactLinks"}]},migrations:[{tag:"v1",new_sqlite_classes:["ScriptLibrary","ScriptBackend","ArtifactLinks"]}]}));
  await start();
},180000);
afterAll(async()=>{await stop();if(directory)await rm(directory,{recursive:true,force:true});});
async function call(path:string,input:unknown={}){const response=await fetch(`${url}/${path}?library=scheduled`,{method:"POST",body:JSON.stringify(input)});const value=await response.json() as any;if(!response.ok)throw new Error(JSON.stringify(value)+logs);return value.result;}
(enabled?test:test.skip)("celld persists schedules and run history across process restart and delivers native alarms",async()=>{
  const identity={workspace:"default",name:"handler"};
  const code=`export default {fetch(request,env){if(request.headers.get("x-canvas-internal-run")!=="caller-value")return new Response("header changed",{status:422});env.sql.exec("create table if not exists count(n integer)");env.sql.exec("insert into count values(1)");console.log("tick");return new Response("ok")}}`;
  const draft=await call("writeDraft",{...identity,source:code});
  const active=await call("activate",{...identity,source_hash:draft.source_hash,code});
  await call("link",{hash:active.hash});
  await call("backend/schedule",{action:"set",identity:{...identity,libraryKey:"scheduled",origin:url},cron:"* * * * *",timezone:"UTC",request:{path:"/tick",method:"POST",headers:[["x-canvas-internal-run","caller-value"]]}});
  await call("backend/schedule",{action:"pause"});
  await call("backend/schedule",{action:"run_now"});
  expect((await call("backend/runs"))[0]).toMatchObject({status:"succeeded",trigger:"manual"});
  await stop();await start();
  expect(await call("backend/schedule")).toMatchObject({paused:true,cron:"* * * * *",timezone:"UTC"});
  expect(await call("backend/runs")).toHaveLength(1);
  await call("backend/schedule",{action:"resume"});
  await call("backend/due");
  const deadline=Date.now()+20000;let runs:any[]=[];
  while(Date.now()<deadline){runs=await call("backend/runs");if(runs.some(r=>r.trigger==="schedule"&&r.status!=="running"))break;await Bun.sleep(100);}
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({trigger:"schedule",status:"succeeded"});
  const runLogs=await call("backend/logs",{run_id:runs[0].id});
  expect(runLogs.some((log:any)=>log.message==="tick"&&log.run_id===runs[0].id)).toBe(true);
  await call("backend/repeatAlarm");
  expect(await call("backend/runs")).toHaveLength(2);
  await call("backend/schedule",{action:"pause"});
},90000);
