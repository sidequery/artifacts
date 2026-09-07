import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { chromium } from "playwright";
import { typecheckCanvas } from "../src/typecheck";
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
  const source = `import { Button, H1, Stack, useCanvasState } from "herdr/canvas";
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

test("checks examples, both SDK aliases, semantic errors and forbidden imports like the local compiler", async () => {
  const cases = [
    example,
    example.replaceAll("herdr/canvas", "cursor/canvas"),
    'import { H1 } from "herdr/canvas";\nconst value: number = "wrong";\nexport default function Canvas() { return <H1>{value}</H1>; }',
    'import { Button } from "herdr/canvas";\nexport default function Canvas() { return <Button tone="not-a-tone">Bad</Button>; }',
    'import { Missing } from "herdr/canvas";\nexport default function Canvas() { return <Missing />; }',
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
  const result = await call(cases[5]!);
  expect(result.ok).toBe(false);
  expect(result.js).toBeUndefined();
  expect(outbound).toEqual([]);
}, 60000);

test("repeated and concurrent compilations keep source separate", async () => {
  const started = performance.now();
  const outputs = await Promise.all(["alpha", "beta", "gamma"].map(label => call(`import { H1 } from "herdr/canvas";\nexport default function Canvas() { return <H1>${label}-unique</H1>; }`)));
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
