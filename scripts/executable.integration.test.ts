import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const binary = resolve(process.env.ARTIFACTS_EXECUTABLE ?? join(import.meta.dir, `../dist/binaries/artifacts-${process.platform}-${process.arch}`));
test("one executable runs CLI, compiler and MCP without Bun or a source checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-executable-test-"));
  const env = { PATH: "/usr/bin:/bin", HOME: join(directory,"home"), ARTIFACTS_DATA_HOME: join(directory,"data"), HERDR_CANVAS_HISTORY_DB: join(directory,"history.sqlite") };
  const run = async (args: string[]) => {
    const child = Bun.spawn([binary,...args],{cwd:directory,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
    const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code!==0) throw new Error(`${args[0]} failed: ${err}\n${out}`);
    return out;
  };
  let client: Client | undefined;
  try {
    expect(await run(["version"])).toContain("@sidequery/artifacts");
    const help = await run(["help"]);
    expect(help).toContain("artifacts host install");
    expect(help).not.toContain("tailscale");
    const source = join(directory,"hello.canvas.tsx");
    await Bun.write(source, 'import {H1} from "sidequery/artifacts"; export default function Hello(){return <H1>Standalone Canvas</H1>}');
    expect(JSON.parse(await run(["write","hello","--file",source,"--dir",join(directory,"canvases")])).ok).toBe(true);
    expect(JSON.parse(await run(["compile","hello","--dir",join(directory,"canvases")])).bytes).toBeGreaterThan(1000);
    client = new Client({name:"standalone-test",version:"1"});
    await client.connect(new StdioClientTransport({command:binary,args:["mcp","--dir",join(directory,"canvases")],env,stderr:"pipe"}));
    expect((await client.listTools()).tools.some(tool=>tool.name==="artifact_write")).toBe(true);
    expect((await client.callTool({name:"artifact_guide",arguments:{}})).isError).not.toBe(true);
    const packages = await readdir(join(directory,"data/packages"));
    expect(packages).toHaveLength(1);
    const packaged = join(directory,"data/packages",packages[0]!,"package");
    expect(existsSync(join(packaged,"deployments"))).toBe(false);
    expect(existsSync(join(packaged,"dist/runner-status"))).toBe(false);
    const native = join(packaged,"native");
    expect(await Bun.file(join(native,"celld")).exists()).toBe(true);
    expect(await Bun.file(join(native,"esbuild")).exists()).toBe(true);
    // Native executables were embedded; no managed runtime download was needed.
    expect(existsSync(join(directory,"data/runtimes/celld"))).toBe(false);
  } finally {await client?.close();await rm(directory,{recursive:true,force:true});}
},180000);
