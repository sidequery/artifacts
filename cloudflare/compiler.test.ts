import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { chromium } from "playwright";
import { typecheckCanvas } from "../src/typecheck";
import { HOOKS_CANVAS } from "../src/test/fixtures";
import type { Diagnostic } from "../src/diagnostics";

let runtime: Miniflare;
let temporary: string;
const outbound: string[] = [];
const example = await readFile(new URL("../examples/overview.canvas.tsx", import.meta.url), "utf8");
type Result = { ok?: boolean; js?: string; diagnostics: Diagnostic[] };
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "canvas-workerd-"));
  const modulesRoot = join(import.meta.dir, "../dist/worker");
  const modules: Record<string, { type: "esm" | "wasm"; contents: string | Uint8Array<ArrayBuffer> }> = {};
  for (const name of await readdir(modulesRoot)) {
    if (name.endsWith(".js")) modules[name] = { type: "esm", contents: await readFile(join(modulesRoot, name), "utf8") };
    if (name.endsWith(".wasm")) modules[name] = { type: "wasm", contents: await readFile(join(modulesRoot, name)) };
  }
  runtime = new Miniflare({
    cf: false, port: 0,
    workers: [{
      config: {
        name: "canvas-compiler-test", type: "worker",
        compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "dev.js", modulesRoot, modules },
      },
      dev: { outboundService: { type: "fetcher", handler: request => {
        outbound.push(request.url);
        return new MiniflareResponse("Network disabled in compiler tests", { status: 503 });
      } } },
    }],
  });
  await runtime.ready;
}, 30000);
afterAll(async () => {
  await runtime?.dispose();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
async function call(source: string, operation = "compile"): Promise<Result> {
  const response = await runtime.dispatchFetch(`http://localhost/${operation}`, { method: "POST", body: source });
  expect(response.status).toBe(200);
  return response.json() as Promise<Result>;
}

test("compiles the real SDK in workerd without network and renders an interactive canvas", async () => {
  const health = await (await runtime.dispatchFetch("http://localhost/health")).json() as { runtime: string };
  expect(health.runtime).toBe("Cloudflare-Workers");
  const source = `import { Button, H1, Stack, useCanvasState } from "sidequery/canvas";
export default function Canvas() {
  const [count, setCount] = useCanvasState("count", 0);
  return <Stack><H1>Worker canvas</H1><Button onClick={() => setCount(count + 1)}>Count {count}</Button></Stack>;
}`;
  const started = performance.now();
  const result = await call(source);
  console.log(`workerd cold compile: ${Math.round(performance.now() - started)} ms, ${result.js?.length ?? 0} JS bytes`);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
    await page.locator("iframe").evaluate((element, js) => {
      (element as HTMLIFrameElement).srcdoc = `<div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`;
    }, result.js!);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Worker canvas" }).waitFor();
    await frame.getByRole("button", { name: "Count 0" }).click();
    await frame.getByRole("button", { name: "Count 1" }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
  expect(outbound).toEqual([]);
}, 30000);

test("checks examples, canonical and legacy SDK imports, semantic errors and forbidden imports like the local compiler", async () => {
  const cases = [
    example,
    example.replaceAll("sidequery/canvas", "herdr/canvas"),
    example.replaceAll("sidequery/canvas", "cursor/canvas"),
    'import { H1 } from "sidequery/canvas";\nconst value: number = "wrong";\nexport default function Canvas() { return <H1>{value}</H1>; }',
    'import { Button } from "sidequery/canvas";\nexport default function Canvas() { return <Button tone="not-a-tone">Bad</Button>; }',
    'import { Missing } from "sidequery/canvas";\nexport default function Canvas() { return <Missing />; }',
    'import thing from "missing-package";\nexport default function Canvas() { return <div>{thing}</div>; }',
  ];
  for (const [index, source] of cases.entries()) {
    const path = join(temporary, `${index}.canvas.tsx`);
    await writeFile(path, source);
    const local = typecheckCanvas(path);
    const remote = await call(source, "typecheck");
    const comparable = (diagnostics: Diagnostic[]) => diagnostics.map(({ message, line, column }) => ({ message, line, column }));
    expect(comparable(remote.diagnostics)).toEqual(comparable(local));
  }
  const result = await call(cases.at(-1)!);
  expect(result.ok).toBe(false);
  expect(result.js).toBeUndefined();
  expect(outbound).toEqual([]);
}, 60000);

test("repeated and concurrent compilations keep source separate", async () => {
  const started = performance.now();
  const outputs = await Promise.all(["alpha", "beta", "gamma"].map(label => call(`import { H1 } from "sidequery/canvas";\nexport default function Canvas() { return <H1>${label}-unique</H1>; }`)));
  for (const [index, result] of outputs.entries()) {
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.js).toContain(["alpha", "beta", "gamma"][index] + "-unique");
    for (const other of ["alpha", "beta", "gamma"].filter((_, otherIndex) => otherIndex !== index)) expect(result.js).not.toContain(other + "-unique");
  }
  console.log(`workerd three warm compilations: ${Math.round(performance.now() - started)} ms`);
  expect(outbound).toEqual([]);
}, 60000);

test("bounds source input", async () => {
  const response = await runtime.dispatchFetch("http://localhost/compile", { method: "POST", body: " ".repeat(256 * 1024 + 1) });
  expect(response.status).toBe(413);
});

test("compiles native Durable Object server APIs with semantic diagnostics and keeps client imports isolated", async () => {
  const source = `import { DurableObject } from "cloudflare:workers";
export class CanvasServer extends DurableObject {
  fetch(request: Request) {
    this.ctx.storage.sql.exec("create table if not exists counter (n integer)");
    return Response.json(this.ctx.storage.sql.exec("select count(*) as n from counter").toArray());
  }
}`;
  const server = await call(source, "compile-server");
  expect(server.diagnostics).toEqual([]);
  expect(server.ok).toBe(true);
  expect(server.js).toContain("cloudflare:workers");
  for (const valid of [
    source.replace('import { DurableObject }', 'import { DurableObject as NativeDO }').replace('extends DurableObject', 'extends NativeDO'),
    source.replace('import { DurableObject } from "cloudflare:workers";', 'import * as workers from "cloudflare:workers";').replace('extends DurableObject', 'extends workers.DurableObject'),
    source.replace('export class CanvasServer extends DurableObject', 'class LocalBase extends DurableObject {}\nexport class CanvasServer extends LocalBase'),
  ]) {
    expect((await call(valid, "typecheck-server")).diagnostics).toEqual([]);
    expect((await call(valid, "compile-server")).ok).toBe(true);
  }
  for (const invalidClass of [
    'export class CanvasServer { fetch() { return new Response("ok"); } }',
    'import { DurableObject } from "cloudflare:workers"; export default class CanvasServer extends DurableObject {}',
    'import { DurableObject } from "cloudflare:workers"; class CanvasServer extends DurableObject {}',
  ]) {
    const checked = await call(invalidClass, "typecheck-server");
    expect(checked.diagnostics.some(diagnostic => diagnostic.message.includes("extending DurableObject"))).toBe(true);
    const compiled = await call(invalidClass, "compile-server");
    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.some(diagnostic => diagnostic.message.includes("extending DurableObject"))).toBe(true);
  }
  const invalid = await call(source.replace("sql.exec", "sql.missingMethod"), "compile-server");
  expect(invalid.ok).toBe(false);
  expect(invalid.diagnostics[0]?.message).toContain("missingMethod");
  const client = await call('import { DurableObject } from "cloudflare:workers"; export default function Canvas() { return <div />; }');
  expect(client.ok).toBe(false);
  const next = await call('import { H1 } from "sidequery/canvas"; export default function Canvas() { return <H1>Still works</H1>; }');
  expect(next.ok).toBe(true);
  expect(outbound).toEqual([]);
}, 60000);

test("a transient server compiler queue overload can be retried", async () => {
  const sources = Array.from({ length: 12 }, (_, index) => `import { DurableObject } from "cloudflare:workers";
export class CanvasServer extends DurableObject { fetch() { return new Response("${index}"); } }`);
  const overloaded = await Promise.all(sources.map(item => call(item, "compile-server")));
  const last = overloaded.at(-1)!;
  expect(last.ok).toBe(false);
  expect(last.diagnostics.some(diagnostic => diagnostic.message.includes("Compiler is busy; retry shortly"))).toBe(true);
  const retried = await call(sources.at(-1)!, "compile-server");
  expect(retried.ok).toBe(true);
  expect(retried.diagnostics).toEqual([]);
}, 60000);

test("ordinary hooks render and update through canonical and legacy hosted SDK imports", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const specifier of ["sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
      const result = await call(HOOKS_CANVAS.replaceAll("sidequery/canvas", specifier));
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
      await page.locator("iframe").evaluate((element, js) => {
        (element as HTMLIFrameElement).srcdoc = `<div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`;
      }, result.js!);
      const app = page.frameLocator("iframe");
      await app.getByRole("button", { name: "Hooks 0:0:0:0:0", exact: true }).click();
      await app.getByRole("button", { name: "Hooks 1:3:1:2:1", exact: true }).click();
      await app.getByRole("button", { name: "Hooks 2:6:2:4:2", exact: true }).waitFor();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); }
  expect(outbound).toEqual([]);
}, 60000);

test("scripts compile arbitrary Workers handlers and reject missing handlers, invalid TypeScript, and unresolved imports", async () => {
  for (const source of [
    'export default { async fetch(request, env, ctx) { return new Response(await request.text(), {status: 202}); } };',
    'export default { async fetch(request: Request, env: ScriptEnv, ctx: ExecutionContext) { env.sql.exec("select 1"); return Response.json({secretPresent: Boolean(env.secrets.TOKEN)}); } } satisfies ExportedHandler<ScriptEnv>;',
    'import { createHash } from "node:crypto"; export default {fetch() {return new Response(createHash("sha256").update("hello").digest("hex"));}};',
  ]) {
    const result=await call(source,"compile-script");
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  }
  for (const source of [
    'export default { nope() {return new Response("no");} };',
    'export default { fetch() {return "not a Response";} };',
    'const count: number = "wrong"; export default {fetch() {return new Response(String(count));}};',
    'import missing from "missing-package"; export default {fetch() {return new Response(missing);}};',
  ]) expect((await call(source,"compile-script")).ok).toBe(false);
  expect((await call('import { H1 } from "sidequery/canvas"; export default function Canvas() { return <H1>After script</H1>; }')).ok).toBe(true);
},60000);

test("a prebundled third-party Hono handler compiles and serves through the script runtime", async () => {
  // This is the supported upload recipe: resolve dependencies locally, keep
  // Workers builtins external, and disable semantic checking of generated JS.
  const bundle = await Bun.build({
    entrypoints: [new URL("./hono-script-test-fixture.ts", import.meta.url).pathname],
    target: "browser", format: "esm", minify: true,
    external: ["node:*", "cloudflare:*"], banner: "// @ts-nocheck",
  });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  expect(bundle.outputs).toHaveLength(1);
  const upload = await bundle.outputs[0]!.text();
  expect(new TextEncoder().encode(upload).byteLength).toBeLessThanOrEqual(256 * 1024);
  const compiled = await call(upload, "compile-script");
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ok).toBe(true);
  expect(outbound).toEqual([]);

  const host = await Bun.build({
    entrypoints: [new URL("./scripts-test-worker.ts", import.meta.url).pathname],
    target: "browser", format: "esm", external: ["cloudflare:workers", "node:*", "fs", "fs/promises"],
  });
  if (!host.success) throw new Error(host.logs.join("\n"));
  const execution = new Miniflare({
    cf: false, port: 0,
    workers: [{
      config: {
        name: "prebundled-script-test", type: "worker",
        compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "test.js", modulesRoot: import.meta.dir,
          modules: { "test.js": { type: "esm", contents: await host.outputs[0]!.text() } },
        },
        env: {
          SCRIPTS: { type: "durable-object", worker: "prebundled-script-test", exportName: "ScriptLibrary" },
          SCRIPT_BACKENDS: { type: "durable-object", worker: "prebundled-script-test", exportName: "ScriptBackend" },
          LOADER: { type: "worker-loader" },
        },
        exports: {
          ScriptLibrary: { type: "durable-object", storage: "sqlite" },
          ScriptBackend: { type: "durable-object", storage: "sqlite" },
        },
      },
      dev: {},
    }],
  });
  try {
    await execution.ready;
    const validation = await execution.dispatchFetch("https://test.invalid/validate", {
      method: "POST", body: JSON.stringify({ code: compiled.js, hash: "hono", secrets: {} }),
    });
    expect(await validation.json()).toEqual({ ok: true });
    const response = await execution.dispatchFetch("https://test.invalid/run", {
      method: "POST", body: JSON.stringify({ code: compiled.js, secrets: {}, body: "third-party\r\npayload" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      framework: "hono", segment: "path", query: "two", method: "POST",
      header: "yes", body: "third-party\r\npayload",
    });
  } finally {
    await execution.dispose();
  }
}, 60000);

// Build the fixture deployment, then run this gated integration test:
// CANVAS_PLUGINS_CONFIG=src/test/plugins/config.ts bun run build:cloudflare-compiler
// CANVAS_PLUGIN_TEST=1 bun test cloudflare/compiler.test.ts --test-name-pattern 'deployment browser plugin' --timeout 60000
// Restore the default deployment afterward with: bun run build:cloudflare-compiler
test.skipIf(process.env.CANVAS_PLUGIN_TEST !== "1")("deployment browser plugin compiles, checks types, and shares React hooks in workerd", async () => {
  const source = `import { PluginCounter, type Label } from "@test/counter";
const label: Label = { prefix: "Plugin" };
export default function Canvas() { return <PluginCounter {...label} />; }`;
  expect((await call(source, "typecheck")).diagnostics).toEqual([]);
  const invalidSdkType = source.replace("type Label", "type Label, type Tone").replace("const label", 'const tone: Tone = "invalid-tone"; const label');
  expect((await call(invalidSdkType, "typecheck")).diagnostics.some(item => item.message.includes("invalid-tone"))).toBe(true);
  const invalid = await call(source.replace('prefix: "Plugin"', "prefix: 123"), "typecheck");
  expect(invalid.diagnostics.some(item => item.message.includes("number"))).toBe(true);
  for (const specifier of ["@test/counter/deep", "jose", "uninstalled"]) {
    const denied = await call(source.replace("@test/counter", specifier));
    expect(denied.ok).toBe(false);
    expect(denied.diagnostics.some(item => item.message.includes("not allowed"))).toBe(true);
  }
  const result = await call(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
    await page.locator("iframe").evaluate((element, js) => {
      (element as HTMLIFrameElement).srcdoc = `<div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>`;
    }, result.js!);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "UGx1Z2luIDA", exact: true }).click();
    await frame.getByRole("button", { name: "UGx1Z2luIDE", exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
  expect(outbound).toEqual([]);
}, 60000);

async function callProject(source: string, project: object, operation = "compile"): Promise<Result> {
  const response = await runtime.dispatchFetch(`http://localhost/${operation}`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({source,project}) });
  expect(response.status).toBe(200);
  return response.json() as Promise<Result>;
}
test("compiles archived multi-file projects and typed packages without network", async () => {
  const project = {files:{"lib/greeting.ts":"export const greeting: string = 'project-hello';"},dependencies:{"tiny-example":"1.0.0"},lock:{
    "node_modules/tiny-example/package.json":JSON.stringify({name:"tiny-example",version:"1.0.0",main:"index.js",types:"index.d.ts"}),
    "node_modules/tiny-example/index.js":"export const answer = 42;",
    "node_modules/tiny-example/index.d.ts":"export const answer: number;",
  }};
  const source = 'import {greeting} from "./lib/greeting"; import {answer} from "tiny-example"; export default function Canvas(){return <div>{greeting} {answer}</div>}';
  const result=await callProject(source,project);
  expect(result.diagnostics).toEqual([]); expect(result.ok).toBe(true); expect(result.js).toContain("project-hello");
  const script=await callProject('import {greeting} from "./lib/greeting"; import {answer} from "tiny-example"; export default {fetch(){return new Response(greeting+answer)}}',project,"compile-script");
  expect(script.diagnostics).toEqual([]); expect(script.ok).toBe(true);
  const bad=await callProject(source,{...project,files:{"lib/greeting.ts":"export const greeting: number = 'bad';"}});
  expect(bad.ok).toBe(false); expect(bad.diagnostics.some(item=>item.file?.includes("greeting.ts"))).toBe(true);
  const separateServer=await callProject(source,{...project,files:{...project.files,"server-only.ts":"export const load = () => fetch('https://example.com');"}});
  expect(separateServer.ok).toBe(true);
  const transitiveUnsafe=await callProject(source,{...project,files:{"lib/greeting.ts":"export {greeting} from './nested';","lib/nested.ts":"export const greeting = fetch('https://example.com');"}});
  expect(transitiveUnsafe.ok).toBe(false); expect(transitiveUnsafe.diagnostics.some(item=>item.file === "lib/nested.ts")).toBe(true);
  const unsafe=await callProject(source,{...project,files:{"lib/greeting.ts":"export const greeting = fetch('https://example.com');"}});
  expect(unsafe.ok).toBe(false); expect(unsafe.diagnostics.some(item=>item.message.includes("fetch()"))).toBe(true);
  expect(outbound).toEqual([]);
},60000);

test("package components use the host React hook runtime",async()=>{
 const result=await callProject('import {Counter} from "counter-package"; export default function Canvas(){return <Counter/>}',{dependencies:{"counter-package":"1.0.0"},lock:{
   "node_modules/counter-package/package.json":JSON.stringify({name:"counter-package",version:"1.0.0",main:"index.js",types:"index.d.ts"}),
   "node_modules/counter-package/index.js":'import {useState,createElement} from "react"; export function Counter(){const [n,setN]=useState(0); return createElement("button",{onClick:()=>setN(n+1)},"Package count "+n)}',
   "node_modules/counter-package/index.d.ts":'export function Counter(): import("react").ReactElement;',
 }});
 expect(result.diagnostics).toEqual([]); expect(result.ok).toBe(true);
 const browser=await chromium.launch({headless:true});
 try {const page=await browser.newPage();await page.setContent('<div id="root"></div>');await page.addScriptTag({type:"module",content:result.js!}); await page.getByRole("button",{name:"Package count 0"}).click();await page.getByRole("button",{name:"Package count 1"}).waitFor();}finally{await browser.close();}
 expect(outbound).toEqual([]);
},60000);

test.skipIf(process.env.CANVAS_PACKAGE_INTEGRATION !== "1")("compiles an integrity-verified Hono dependency snapshot without compiler network",async()=>{
  const {resolveProject}=await import("./project");
  const project=await resolveProject({dependencies:{hono:"4.13.7"},files:{"lib/message.ts":"export const message = 'hello-locked-hono';"}});
  const result=await callProject('import {Hono} from "hono"; import {message} from "./lib/message"; const app=new Hono(); app.get("/",c=>c.text(message)); export default app;',project,"compile-script");
  expect(result.diagnostics).toEqual([]); expect(result.ok).toBe(true); expect(result.js).toContain("hello-locked-hono");
  expect(outbound).toEqual([]);
},120000);
