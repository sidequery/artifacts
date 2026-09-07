import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import * as ReactRouter from "react-router";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JSX from "react/jsx-runtime";
import * as JSXDev from "react/jsx-dev-runtime";
import type { CanvasPlugin } from "../src/plugins/config";
import type { BrowserPlugins } from "../src/plugins/types";
import { PLUGIN_ROOT, SDK_ENTRY } from "../src/paths";

const shared = ["react-router", "react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "sidequery/canvas", "herdr/canvas", "cursor/canvas", "@sidequery/canvas"];

/** Only browser entries enter this graph. Configuration and handlers are never bundled. */
export async function prepareBrowserPlugins(plugins: readonly CanvasPlugin[], configDir: string): Promise<BrowserPlugins> {
  const result: BrowserPlugins = { modules: {}, files: {}, paths: {} };
  const browserPlugins = plugins.filter(plugin => plugin.browser);
  if (!browserPlugins.length) return result;
  for (const plugin of browserPlugins) {
    // Resolve the original specifier with browser conditions. Resolving it with
    // Bun first would lock conditional exports to the build host's runtime.
    const bundle = await build({
      entryPoints: [plugin.browser!], absWorkingDir: resolve(configDir), bundle: true,
      platform: "browser", format: "esm", target: "es2022", jsx: "automatic", write: false,
      external: shared, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    });
    if (bundle.outputFiles.length !== 1) throw new Error(`Browser plugin ${plugin.name} must produce one JavaScript module`);
    result.modules[plugin.name] = bundle.outputFiles[0]!.text;
    collectTypes(plugin, resolve(configDir), result);
  }
  for (const [specifier, namespace, exports] of [
    ["react-router", "reactRouter", ReactRouter], ["react", "react", React], ["react-dom", "reactDom", ReactDOM],
    ["react-dom/client", "reactDomClient", ReactDOMClient],
    ["react/jsx-runtime", "jsx", JSX], ["react/jsx-dev-runtime", "jsxDev", JSXDev],
  ] as const) {
    result.modules[specifier] = `const namespace = globalThis.__herdrCanvasRuntime.${namespace};\nexport default namespace;\n` +
      Object.keys(exports).filter(name => name !== "default" && /^[\w$]+$/.test(name)).sort()
        .map(name => `export const ${name} = namespace.${name};`).join("\n");
  }
  return result;
}

function collectTypes(plugin: CanvasPlugin, configDir: string, output: BrowserPlugins) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, declaration: true, emitDeclarationOnly: true, allowJs: true,
    skipLibCheck: true, esModuleInterop: true, types: [], customConditions: ["browser"], baseUrl: PLUGIN_ROOT,
    paths: Object.fromEntries(shared.filter(name => name.endsWith("/canvas")).map(name => [name, [SDK_ENTRY]])),
  };
  const host = ts.createCompilerHost(options);
  const resolveType = (specifier: string, containing: string) => ts.resolveModuleName(specifier, containing, options, host).resolvedModule;
  const requested = plugin.types ?? plugin.browser!;
  const typeEntry = resolveType(requested, join(configDir, "__plugins.ts"))?.resolvedFileName
    ?? Bun.resolveSync(requested, configDir);
  const program = ts.createProgram([typeEntry], options, host);
  const sources = program.getSourceFiles().filter(file => !program.isSourceFileDefaultLibrary(file));
  // Core types retain their canonical paths so SDK and plugins agree on React.
  const core = (path: string) => path.startsWith(join(PLUGIN_ROOT, "src/sdk") + "/")
    || /\/node_modules\/(?:@types\/(?:react|react-dom)|csstype)(?:\/|$)/.test(path);
  const selected = sources.filter(file => !core(file.fileName));
  const virtual = new Map(selected.map(file => {
    const path = relative(configDir, file.fileName).split("/").map(part => part === ".." ? "_up" : part).join("/");
    return [file.fileName, `plugins/types/${encodeURIComponent(plugin.name)}/${path.replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/, ".d.ts").replace(/\.d\.d\.ts$/, ".d.ts")}`];
  }));
  const declarationText = new Map<string, string>();
  const emitted = program.emit(undefined, (_path, text, _bom, _error, sourceFiles) => {
    for (const source of sourceFiles ?? []) declarationText.set(source.fileName, text);
  }, undefined, true);
  if (emitted.emitSkipped) throw new Error(`Could not emit browser declarations for ${plugin.name}`);
  for (const file of selected) {
    const destination = virtual.get(file.fileName)!;
    const text = file.isDeclarationFile ? file.text : declarationText.get(file.fileName);
    if (text === undefined) throw new Error(`No browser declarations for ${plugin.name}: ${file.fileName}`);
    const tree = ts.createSourceFile(destination, text, ts.ScriptTarget.Latest, true);
    const replacements: { start: number; end: number; value: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && (
        ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) ||
        ts.isExternalModuleReference(node.parent) || ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)
      )) {
        const resolved = resolveType(node.text, file.fileName)?.resolvedFileName;
        const target = resolved && virtual.get(resolved);
        if (target) {
          const path = relative(dirname(destination), target).replace(/\.d\.ts$/, "");
          replacements.push({ start: node.getStart(tree), end: node.end, value: JSON.stringify(path.startsWith(".") ? path : `./${path}`) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const reference of tree.referencedFiles) {
      const target = virtual.get(resolve(dirname(file.fileName), reference.fileName));
      if (target) replacements.push({ start: reference.pos, end: reference.end, value: relative(dirname(destination), target) });
    }
    let rewritten = text;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
    output.files[destination] = rewritten;
  }
  const publicEntry = virtual.get(typeEntry);
  if (!publicEntry) throw new Error(`Browser plugin ${plugin.name} needs its own resolvable type entry`);
  output.paths[plugin.name] = [publicEntry];
}
