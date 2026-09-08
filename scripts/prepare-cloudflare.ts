import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { canvasAppHtml } from "../src/mcp/app";
import { galleryBundle, galleryHtml } from "../src/gallery/server";
import { authBundle, authPageHtml } from "../src/auth/server";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone";
import { CLOUD_MCP_TOOLS } from "../cloudflare/tool-contract";
import { createHash } from "node:crypto";
import * as sdk from "../src/sdk";
import * as react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as reactRouter from "react-router";
import * as jsx from "react/jsx-runtime";
import * as jsxDev from "react/jsx-dev-runtime";
import { preparePlugins } from "./prepare-plugins";

// Ship the lockfile-resolved dependencies with the compiler. Compiling a canvas
// must never install packages or depend on npm being available at request time.
const root = join(import.meta.dir, "..");
const plugins = await preparePlugins(root, join(root, "dist/cloudflare"));
const files: Record<string, string> = {};
async function collect(directory: string, accept: (path: string) => boolean) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, accept);
    else if (accept(path)) files[path] = await readFile(join(root, path), "utf8");
  }
}
await collect("src/sdk", path => /\.(ts|tsx)$/.test(path) && !path.endsWith(".test.ts"));
files["src/httpTypes.ts"] = await readFile(join(root, "src/httpTypes.ts"), "utf8");
files["src/plugins/types.ts"] = await readFile(join(root, "src/plugins/types.ts"), "utf8");
for (const name of ["react", "react-dom", "scheduler", "@types/react", "@types/react-dom", "csstype", "@types/node", "undici-types", "react-router", "cookie", "set-cookie-parser"]) {
  await collect(`node_modules/${name}`, path => /\.d\.[cm]?ts$/.test(path) || path.endsWith("/package.json"));
}
await collect("node_modules/typescript/lib", path => /\/lib\.[^/]+\.d\.ts$/.test(path));
files["node_modules/@cloudflare/workers-types/index.d.ts"] = await readFile(join(root, "node_modules/@cloudflare/workers-types/index.d.ts"), "utf8");
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
  sharedVersions: Object.fromEntries(await Promise.all(["react", "react-dom", "react-router"].map(async name => [name, JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version]))),
  sharedModules: Object.fromEntries(Object.entries({ react: { value: react, key: "react" }, "react-dom": { value: reactDom, key: "reactDom" }, "react-dom/client": { value: reactDomClient, key: "reactDomClient" }, "react-router": { value: reactRouter, key: "reactRouter" }, "react/jsx-runtime": { value: jsx, key: "jsx" }, "react/jsx-dev-runtime": { value: jsxDev, key: "jsxDev" } }).map(([name, {value, key}]) => [name, `export default globalThis.__herdrCanvasRuntime.${key};\n` + Object.keys(value).filter(item => item !== "default" && /^[A-Za-z_$][\w$]*$/.test(item)).map(item => `export const ${item} = globalThis.__herdrCanvasRuntime.${key}.${item};`).join("\n")])),
  sdkModule: Object.keys(sdk).sort().map(name => `export const ${name} = globalThis.__herdrCanvasRuntime.sdk.${name};`).join("\n"),
}));
const identity = createHash("sha256").update(JSON.stringify(files)).update(runtimeJs)
  .update(JSON.stringify(plugins.browser)).update(JSON.stringify(plugins.catalog))
  .update(await readFile(join(root, "bun.lock"), "utf8"))
  .update(await readFile(join(root, "cloudflare/compiler.ts"), "utf8"))
  .update(await readFile(join(root, "scripts/prepare-cloudflare.ts"), "utf8"))
  .digest("hex");
await writeFile(join(dirname(output), "identity.json"), JSON.stringify({ runtime: `workerd:canvas-0.1.0:${identity}` }));
const assets = join(root, "dist/cloudflare/assets");
await mkdir(assets, { recursive: true });
await writeFile(join(assets, "index.html"), galleryHtml());
await writeFile(join(assets, "gallery.js"), await galleryBundle());
await writeFile(join(assets, "auth.html"), authPageHtml());
await writeFile(join(assets, "auth.js"), await authBundle());
await writeFile(join(dirname(output), "mcp-app.json"), JSON.stringify(await canvasAppHtml()));
const galleryBridge = await Bun.build({ entrypoints: [join(root, "src/runtime/gallery-request.ts")], target: "browser", format: "iife", minify: true });
if (!galleryBridge.success) throw new Error(galleryBridge.logs.join("\n"));
await writeFile(join(dirname(output), "gallery-request.json"), JSON.stringify(await galleryBridge.outputs[0]!.text()));
// Compile trusted schemas at build time: Workers must not need eval() to
// validate arguments, and the listed schema stays the validation source.
const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: true } });
for (const tool of CLOUD_MCP_TOOLS) ajv.addSchema(tool.inputSchema, tool.name);
await writeFile(join(dirname(output), "tool-validators.js"), standaloneCode(ajv, Object.fromEntries(CLOUD_MCP_TOOLS.map(tool => [tool.name, tool.name]))));
await writeFile(join(dirname(output), "tool-validators.d.ts"), 'import type { ValidateFunction } from "ajv";\n' + CLOUD_MCP_TOOLS.map(tool => `export const ${tool.name}: ValidateFunction;`).join("\n"));
console.log(`Prepared ${Object.keys(files).length} compiler files: ${relative(root, output)}`);

const navigation = await Bun.build({ entrypoints: [join(root, "src/runtime/navigation-host.ts")], target: "browser", format: "iife", minify: true });
if (!navigation.success) throw new Error(navigation.logs.join("\n"));
await writeFile(join(dirname(output), "navigation-host.json"), JSON.stringify(await navigation.outputs[0]!.text()));
