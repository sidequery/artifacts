import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,test} from "bun:test";
import {chromium} from "playwright";

test("schedule controls ignore unfinished request fields except when saving",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"execution-controls-"));
  const entry=join(directory,"fixture.tsx");
  await Bun.write(entry,`import {createElement} from ${JSON.stringify(Bun.resolveSync("react",import.meta.dir))};import {createRoot} from ${JSON.stringify(Bun.resolveSync("react-dom/client",import.meta.dir))};import {ExecutionControls} from ${JSON.stringify(new URL("../src/gallery/execution-controls.tsx",import.meta.url).pathname)};createRoot(document.getElementById("root")).render(createElement(ExecutionControls,{workspace:"default",name:"example"}));`);
  let build;
  try { build=await Bun.build({entrypoints:[entry],target:"browser"}); } finally { await rm(directory,{recursive:true,force:true}); }
  expect(build.success).toBe(true);
  const js=await build.outputs[0]!.text();
  const actions:string[]=[];
  let schedule={interval_seconds:3600,paused:false,next_run_at:Date.now()+3600000,request:{path:"/",method:"GET",headers:[]}};
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    if(new URL(request.url).pathname==="/client.js")return new Response(js,{headers:{"content-type":"text/javascript"}});
    if(new URL(request.url).pathname==="/api/tools"){
      const call=await request.json() as {arguments:{action:string}};actions.push(call.arguments.action);
      if(call.arguments.action==="pause")schedule={...schedule,paused:true};
      if(call.arguments.action==="resume")schedule={...schedule,paused:false};
      return Response.json({structuredContent:{schedule}});
    }
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>',{headers:{"content-type":"text/html"}});
  }});
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.goto(server.url.href);
    await page.getByText("Schedule",{exact:true}).click();
    await page.getByLabel("Schedule headers").fill("{");
    await page.getByRole("button",{name:"Load schedule",exact:true}).click();
    await page.getByText("Next run:",{exact:false}).waitFor();
    await page.getByLabel("Schedule headers").fill("{");
    await page.getByRole("button",{name:"Pause schedule",exact:true}).click();
    await page.getByRole("button",{name:"Resume schedule",exact:true}).click();
    await page.getByRole("button",{name:"Run schedule now",exact:true}).click();
    await page.getByRole("button",{name:"Save schedule",exact:true}).click();
    await page.getByRole("alert").waitFor();
    expect(actions).toEqual(["get","pause","resume","run_now"]);
  }finally{await browser.close();server.stop(true);}
},30000);
