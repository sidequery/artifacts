import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { emptyProject, normalizeProject, packageFiles, resolveProject } from "./project";
function tar(files: Record<string,string>) {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), header = Buffer.alloc(512);
    header.write(`package/${name}`); header.write(data.length.toString(8).padStart(11,"0"),124); header[156] = 48;
    parts.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
const archive = tar({"package.json": JSON.stringify({name:"example",version:"1.0.0",main:"index.js"}), "index.js":"export const answer = 42;", "index.d.ts":"export const answer: number;"});
const manifest = {name:"example",version:"1.0.0",dist:{tarball:"https://registry.npmjs.org/example/-/example-1.0.0.tgz",integrity:`sha512-${createHash("sha512").update(archive).digest("base64")}`}};
const fetcher = (async (input: string | URL | Request) => String(input).endsWith(".tgz") ? new Response(archive) : Response.json({versions:{"1.0.0":manifest}})) as typeof fetch;
test("exact dependency resolution verifies integrity and freezes source for offline edits",async()=>{
  const project=await resolveProject({files:{"helper.ts":"export const label = 'ok'"},dependencies:{example:"1.0.0"}},undefined,fetcher);
  expect(project.lock["node_modules/example/index.js"]).toContain("42");
  const offline = (async()=>{throw new Error("must not fetch")}) as typeof fetch;
  const edited=await resolveProject({files:{"helper.ts":"export const label = 'edited'"},dependencies:{example:"1.0.0"}},project,offline);
  expect(edited.lock).toEqual(project.lock);
  expect(edited.files["helper.ts"]).toContain("edited");
  await expect(packageFiles({...manifest,dist:{...manifest.dist,integrity:"sha512-invalid"}},fetcher)).rejects.toThrow("integrity mismatch");
  await expect(packageFiles({...manifest,dist:{...manifest.dist,tarball:"https://evil.example/package.tgz"}},fetcher)).rejects.toThrow("registry.npmjs.org");
});
test("project rejects traversal, reserved entrypoints, mutable versions and uploaded locks",async()=>{
  for (const path of ["../escape.ts","/absolute.ts","entry.ts","node_modules/foo/index.js","a/../b.ts","a//b.ts"]) expect(()=>normalizeProject({files:{[path]:""}})).toThrow();
  for (const version of ["latest","^1.0.0","https://example.com/x","github:a/b"]) expect(()=>normalizeProject({dependencies:{foo:version}})).toThrow("exact semver");
  await expect(resolveProject({lock:{"node_modules/a/index.js":"evil"}})).rejects.toThrow("read-only");
  expect(normalizeProject(undefined)).toEqual(emptyProject());
});
test("transitive version conflicts and required peers produce actionable errors",async()=>{
  const manifests: Record<string,object> = {
    alpha:{name:"alpha",version:"1.0.0",dependencies:{shared:"^1.0.0"}},
    beta:{name:"beta",version:"1.0.0",dependencies:{shared:"^2.0.0"}},
    shared:{name:"shared",version:"1.0.0"},
    peer:{name:"peer",version:"1.0.0",peerDependencies:{missing:"^1.0.0"}},
  };
  const fake=(async(input:string|URL|Request)=>{
    const url=String(input), name=new URL(url).pathname.slice(1).split("/")[0]!;
    if(url.endsWith(".tgz"))return new Response(archive);
    return Response.json({versions:{"1.0.0":{...manifests[name],dist:{...manifest.dist,tarball:`https://registry.npmjs.org/${name}/archive.tgz`}}}});
  }) as typeof fetch;
  await expect(resolveProject({dependencies:{alpha:"1.0.0",beta:"1.0.0"}},undefined,fake)).rejects.toThrow("dependency conflict");
  await expect(resolveProject({dependencies:{peer:"1.0.0"}},undefined,fake)).rejects.toThrow("declare a compatible exact version");
});

test("direct pins take precedence over newer compatible transitive candidates",async()=>{
  const manifests: Record<string,Record<string,object>> = {
    alpha:{"1.0.0":{name:"alpha",version:"1.0.0",dependencies:{shared:"^1.0.0"}}},
    shared:{"1.0.0":{name:"shared",version:"1.0.0"},"1.1.0":{name:"shared",version:"1.1.0"}},
  };
  const fake=(async(input:string|URL|Request)=>{
    const url=String(input), name=new URL(url).pathname.slice(1).split("/")[0]!;
    if(url.endsWith(".tgz"))return new Response(archive);
    return Response.json({versions:Object.fromEntries(Object.entries(manifests[name]!).map(([version,value])=>[version,{...value,dist:{...manifest.dist,tarball:`https://registry.npmjs.org/${name}/${version}.tgz`}}]))});
  }) as typeof fetch;
  const result=await resolveProject({dependencies:{alpha:"1.0.0",shared:"1.0.0"}},undefined,fake);
  expect(Object.keys(result.lock)).toContain("node_modules/shared/index.js");
});
test("browser package peers use compatible host React and reject mismatches without downloading another React",async()=>{
  const requests: string[]=[];
  const fake=(async(input:string|URL|Request)=>{
    const url=String(input); requests.push(url);
    if(url.endsWith(".tgz"))return new Response(archive);
    return Response.json({versions:{"1.0.0":{...manifest,peerDependencies:{react:"^19.0.0"}}}});
  }) as typeof fetch;
  await resolveProject({dependencies:{example:"1.0.0"}},undefined,fake,{react:"19.2.8"});
  expect(requests.some(url=>url.includes("/react"))).toBe(false);
  await expect(resolveProject({dependencies:{example:"1.0.0"}},undefined,fake,{react:"18.3.1"})).rejects.toThrow("requires peer react");
});
