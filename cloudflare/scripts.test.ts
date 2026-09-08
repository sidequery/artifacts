import {afterAll,beforeAll,expect,test} from "bun:test";
import {Miniflare, Response as MFResponse} from "miniflare";
let runtime: Miniflare;
beforeAll(async()=>{
  const build=await Bun.build({entrypoints:[new URL("./scripts-test-worker.ts",import.meta.url).pathname],target:"browser",format:"esm",external:["cloudflare:workers","node:*","fs","fs/promises"]});
  if (!build.success) throw new Error(build.logs.join("\n"));
  runtime=new Miniflare({unsafeInspectDurableObjects:true,cf:false,port:0,workers:[{config:{name:"scripts-test",type:"worker",compatibilityDate:"2026-09-06",compatibilityFlags:["nodejs_compat"],manifest:{mainModule:"test.js",modulesRoot:import.meta.dir,modules:{"test.js":{type:"esm",contents:await build.outputs[0]!.text()}}},env:{SCRIPTS:{type:"durable-object",worker:"scripts-test",exportName:"ScriptLibrary"},SCRIPT_BACKENDS:{type:"durable-object",worker:"scripts-test",exportName:"ScriptBackend"},LOADER:{type:"worker-loader"}},exports:{ScriptLibrary:{type:"durable-object",storage:"sqlite"},ScriptBackend:{type:"durable-object",storage:"sqlite"}}},dev:{outboundService:{type:"fetcher",handler:()=>new MFResponse("upstream success")}}}]});
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

test("remix copies an immutable source revision, never secrets or activation, and preserves provenance",async()=>{
  const workspace="remix",name="original";
  const first=await call("writeDraft",{workspace,name,source:"original code"});
  const [version]=await call("history",{workspace,name});
  await call("setSecret",{workspace,name,key:"TOKEN",value:"secret-value"});
  await call("activate",{workspace,name,source_hash:first.source_hash,code:"compiled"});
  await call("writeDraft",{workspace,name,source:"new draft"});
  const copied=await call("remix",{workspace,version_id:version.id,new_name:"copy"});
  expect(copied).toMatchObject({source:"original code",origin:{source_name:name,source_version_id:version.id}});
  expect(await call("secretNames",{workspace,name:"copy"})).toEqual([]);
  await expect(call("active",{workspace,name:"copy"})).rejects.toThrow("no validated version");
  const [copyVersion]=await call("history",{workspace,name:"copy"});
  expect(await call("version",{workspace,id:copyVersion.id})).toMatchObject({reason:"remix",origin:{source_name:name,source_version_id:version.id}});
  expect(await call("remix",{workspace,name,new_name:"current"})).toMatchObject({source:"new draft"});
  await expect(call("remix",{workspace,name,new_name:"copy"})).rejects.toThrow("already exists");
  await expect(call("remix",{workspace:"other",version_id:version.id,new_name:"copy"})).rejects.toThrow("not found");
  await expect(call("remix",{workspace,version_id:version.id,new_name:"copy"},"bob")).rejects.toThrow("not found");
  await expect(call("remix",{workspace,name,version_id:version.id,new_name:"ambiguous"})).rejects.toThrow("not both");
});

test("project changes invalidate script validation and restore complete module snapshots", async () => {
  const identity = { workspace: "projects", name: "handler" };
  const project = { files: { "helper.ts": "export const answer = 1;", "other.ts": "unchanged" }, dependencies: { "lodash-es": "4.17.21" }, lock: { "node_modules/lodash-es/index.js": "export const version = 1;" } };
  const source = "entry source";
  const legacy = await call("writeDraft", { ...identity, source });
  const first = await call("writeDraft", { ...identity, source, project });
  expect(first.source_hash).not.toBe(legacy.source_hash);
  expect(first.project).toEqual(project);
  const history = await call("history", identity);
  const versionId = history[0].id;
  expect((await call("writeDraft", { ...identity, source })).project).toEqual(project);
  expect(await call("history", identity)).toHaveLength(2);
  const read = await call("readRange", { ...identity, file: "helper.ts" });
  const edited = await call("editDraft", { ...identity, file: "helper.ts", expected_hash: read.source_hash, edits: [{ old_text: "1", new_text: "2" }] });
  expect(edited.source).toBe(source);
  expect(edited.project).toEqual({ ...project, files: { ...project.files, "helper.ts": "export const answer = 2;" } });
  expect(edited.source_hash).not.toBe(first.source_hash);
  await expect(call("activate", { ...identity, source_hash: first.source_hash, code: "compiled" })).rejects.toThrow("changed during validation");
  await expect(call("editDraft", { ...identity, file: "helper.ts", expected_hash: read.source_hash, edits: [{ old_text: "2", new_text: "3" }] })).rejects.toThrow("changed since read");
  await expect(call("editDraft", { ...identity, file: "helper.ts", edits: [{ old_text: "2", new_text: "3" }, { old_text: "missing", new_text: "x" }] })).rejects.toThrow("no changes written");
  expect((await call("readRange", identity)).project).toEqual(edited.project);
  await expect(call("readRange", { ...identity, file: "missing.ts" })).rejects.toThrow("file not found");
  await expect(call("editDraft", { ...identity, file: "missing.ts", edits: [{ old_text: "x", new_text: "y" }] })).rejects.toThrow("file not found");
  expect((await call("version", { workspace: identity.workspace, id: versionId })).project).toEqual(project);
  expect((await call("restore", { workspace: identity.workspace, id: versionId })).project).toEqual(project);
  const empty = { files: {}, dependencies: {}, lock: {} };
  expect((await call("writeDraft", { ...identity, source, project: empty })).source_hash).toBe(legacy.source_hash);
});

test("legacy script tables acquire empty project snapshots without losing drafts or history", async () => {
  const library = "legacy-project-migration";
  const identity = { workspace: "legacy", name: "handler" };
  const written = await call("writeDraft", { ...identity, source: "legacy source" }, library);
  const history = await call("history", identity, library);
  const storage = await runtime.unsafeGetDurableObjectStorage("scripts-test", "ScriptLibrary", { name: library });
  await storage.exec("alter table scripts drop column project");
  await storage.exec("alter table script_versions drop column project");
  await runtime.unsafeEvictDurableObject("scripts-test", "ScriptLibrary", { name: library });
  const empty = { files: {}, dependencies: {}, lock: {} };
  expect(await call("readRange", identity, library)).toMatchObject({ source: written.source, source_hash: written.source_hash, project: empty });
  expect(await call("version", { workspace: identity.workspace, id: history[0].id }, library)).toMatchObject({ source: written.source, source_hash: written.source_hash, project: empty });
});

test("large script projects retain deduplicated chunks across edits and historical restore", async () => {
  const library = "large-project-chunks";
  const identity = { workspace: "chunks", name: "large" };
  const project = { files: { "helper.ts": "export const value = 1;" }, dependencies: { example: "1.0.0" }, lock: { "node_modules/example/index.js": `export const text = "${"😀漢字".repeat(240000)}";` } };
  expect(new TextEncoder().encode(JSON.stringify(project)).byteLength).toBeGreaterThan(2 * 1024 * 1024);
  const source = "entry";
  const original = await call("writeDraft", { ...identity, source, project }, library);
  expect(original.project).toEqual(project);
  const history = await call("history", identity, library);
  const storage = await runtime.unsafeGetDurableObjectStorage("scripts-test", "ScriptLibrary", { name: library });
  const before = await storage.exec<{n: number; largest: number}>("select count(*) as n,max(length(cast(chunk as blob))) as largest from project_chunks");
  expect(before[0]!.n).toBeGreaterThan(1);
  expect(before[0]!.largest).toBeLessThanOrEqual(512 * 1024);
  expect((await call("writeDraft", { ...identity, source }, library)).project).toEqual(project);
  const edited = await call("editDraft", { ...identity, file: "helper.ts", edits: [{ old_text: "1", new_text: "2" }] }, library);
  expect(edited.source_hash).not.toBe(original.source_hash);
  expect(edited.project.lock).toEqual(project.lock);
  expect((await call("version", { workspace: identity.workspace, id: history[0].id }, library)).project).toEqual(project);
  expect((await call("restore", { workspace: identity.workspace, id: history[0].id }, library)).project).toEqual(project);
  await runtime.unsafeEvictDurableObject("scripts-test", "ScriptLibrary", { name: library });
  expect((await call("readRange", identity, library)).project).toEqual(project);
  const after = await storage.exec<{n: number}>("select count(*) as n from project_chunks");
  expect(after[0]!.n).toBeLessThanOrEqual(before[0]!.n + 1);
});

test("inline script project snapshots upgrade transparently on edit and restore", async () => {
  const library = "inline-project-upgrade", identity = { workspace: "upgrade", name: "script" };
  const project = { files: { "helper.ts": "original" }, dependencies: {}, lock: {} };
  await call("writeDraft", { ...identity, source: "entry", project }, library);
  const history = await call("history", identity, library);
  const storage = await runtime.unsafeGetDurableObjectStorage("scripts-test", "ScriptLibrary", { name: library });
  await storage.exec("update scripts set project = ?", JSON.stringify(project));
  await storage.exec("update script_versions set project = ?", JSON.stringify(project));
  await runtime.unsafeEvictDurableObject("scripts-test", "ScriptLibrary", { name: library });
  expect((await call("readRange", identity, library)).project).toEqual(project);
  expect((await call("version", { workspace: identity.workspace, id: history[0].id }, library)).project).toEqual(project);
  const edited = await call("editDraft", { ...identity, file: "helper.ts", edits: [{ old_text: "original", new_text: "changed" }] }, library);
  expect(edited.project.files["helper.ts"]).toBe("changed");
  expect((await call("restore", { workspace: identity.workspace, id: history[0].id }, library)).project).toEqual(project);
});
