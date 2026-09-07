import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { canvasAppHtml } from "../src/mcpApp";
import { galleryBundle, galleryHtml } from "../src/gallery/server";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone";
import { CLOUD_MCP_TOOLS } from "../cloudflare/tool-contract";
import { createHash } from "node:crypto";
import * as sdk from "../src/sdk";

// Ship the lockfile-resolved dependencies with the compiler. Compiling a canvas
// must never install packages or depend on npm being available at request time.
const root = join(import.meta.dir, "..");
const files: Record<string, string> = {};
async function collect(directory: string, accept: (path: string) => boolean) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, accept);
    else if (accept(path)) files[path] = await readFile(join(root, path), "utf8");
  }
}
await collect("src/sdk", path => /\.(ts|tsx)$/.test(path) && !path.endsWith(".test.ts"));
for (const name of ["react", "react-dom", "scheduler", "@types/react", "@types/react-dom", "csstype"]) {
  await collect(`node_modules/${name}`, path => path.endsWith(".d.ts") || path.endsWith("/package.json"));
}
await collect("node_modules/typescript/lib", path => /\/lib\.[^/]+\.d\.ts$/.test(path));
const output = join(root, "dist/cloudflare/compiler-files.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(files));
// Keep the same TypeScript version as the local adapter, but disable its Node
// system probe: all compiler reads are provided by our virtual CompilerHost.
const typescript = await Bun.build({
  entrypoints: [join(root, "node_modules/typescript/lib/typescript.js")],
  target: "browser", format: "esm", minify: true,
  define: { process: "undefined" },
  external: ["fs", "path", "os", "crypto", "perf_hooks", "buffer", "inspector"],
});
if (!typescript.success) throw new Error(typescript.logs.join("\n"));
await writeFile(join(dirname(output), "typescript.js"), await typescript.outputs[0]!.text());
await writeFile(join(dirname(output), "typescript.d.ts"), 'import ts from "typescript"; export default ts;\n');
const runtimeBuild = await Bun.build({
  entrypoints: [join(root, "src/runtime/cloud-runtime.ts")],
  target: "browser", format: "iife", minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!runtimeBuild.success) throw new Error(runtimeBuild.logs.join("\n"));
const runtimeJs = await runtimeBuild.outputs[0]!.text();
await writeFile(join(dirname(output), "browser-runtime.json"), JSON.stringify({
  js: runtimeJs,
  sdkModule: Object.keys(sdk).sort().map(name => `export const ${name} = globalThis.__herdrCanvasRuntime.sdk.${name};`).join("\n"),
}));
const identity = createHash("sha256").update(JSON.stringify(files)).update(runtimeJs)
  .update(await readFile(join(root, "bun.lock"), "utf8"))
  .update(await readFile(join(root, "cloudflare/compiler.ts"), "utf8"))
  .update(await readFile(join(root, "scripts/prepare-cloudflare.ts"), "utf8"))
  .digest("hex");
await writeFile(join(dirname(output), "identity.json"), JSON.stringify({ runtime: `workerd:canvas-0.1.0:${identity}` }));
const assets = join(root, "dist/cloudflare/assets");
await mkdir(assets, { recursive: true });
await writeFile(join(assets, "index.html"), galleryHtml());
await writeFile(join(assets, "gallery.js"), await galleryBundle());
await writeFile(join(dirname(output), "mcp-app.html"), await canvasAppHtml());
// Compile trusted schemas at build time: Workers must not need eval() to
// validate arguments, and the listed schema stays the validation source.
const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: true } });
for (const tool of CLOUD_MCP_TOOLS) ajv.addSchema(tool.inputSchema, tool.name);
await writeFile(join(dirname(output), "tool-validators.js"), standaloneCode(ajv, Object.fromEntries(CLOUD_MCP_TOOLS.map(tool => [tool.name, tool.name]))));
await writeFile(join(dirname(output), "tool-validators.d.ts"), 'import type { ValidateFunction } from "ajv";\n' + CLOUD_MCP_TOOLS.map(tool => `export const ${tool.name}: ValidateFunction;`).join("\n"));
console.log(`Prepared ${Object.keys(files).length} compiler files: ${relative(root, output)}`);
