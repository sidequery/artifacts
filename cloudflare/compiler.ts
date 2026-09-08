import { emptyProject, normalizeProject, type ArtifactProject } from "./project";
import { createWorker } from "@cloudflare/worker-bundler";
import ts from "../dist/cloudflare/typescript.js";
import files from "../dist/cloudflare/compiler-files.json";
import browserPlugins from "../dist/cloudflare/plugin-browser.json";
import browserRuntime from "../dist/cloudflare/browser-runtime.json";
import { sandboxToDiagnostics, type Diagnostic } from "../src/diagnostics";
import { scanCanvasSource } from "../src/sandbox";

const sourcePath = "canvas.canvas.tsx";
const serverPath = "canvas.canvas.server.ts";
const sdkPath = "src/sdk/index.ts";
const compilerFiles: Record<string, string> = { ...files, ...browserPlugins.files };
const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    allowSyntheticDefaultImports: true, baseUrl: "/",
    paths: { ...browserPlugins.paths, "@sidequery/canvas": [sdkPath], "sidequery/canvas": [sdkPath], "herdr/canvas": [sdkPath], "cursor/canvas": [sdkPath] },
    types: [],
};
const normalize = (path: string) => path.replace(/^\//, "");
let currentSource = "";
let currentProject = emptyProject();
let serverMode = false;
let scriptMode = false;
let sourceVersion = 0;
const serverOptions: ts.CompilerOptions = { ...options, paths: {}, lib: ["lib.es2022.d.ts"] };
const read = (path: string) => normalize(path) === (serverMode ? serverPath : sourcePath) ? currentSource : currentProject.files[normalize(path)] ?? currentProject.lock[normalize(path)] ?? compilerFiles[normalize(path)];
// A single bounded language-service project retains the immutable SDK/lib ASTs.
// Typechecking is synchronous, so overlapping requests cannot observe another
// source while checking. No per-user project/program cache accumulates here.
const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => scriptMode ? { ...serverOptions, noImplicitAny: false, types: ["node"] } : serverMode ? serverOptions : options,
    getScriptFileNames: () => serverMode ? [`/${serverPath}`, "/node_modules/@cloudflare/workers-types/index.d.ts"] : [`/${sourcePath}`],
    getScriptVersion: path => {
      const file = normalize(path);
      // Keep immutable SDK/lib ASTs cached while invalidating every project
      // module, including modules removed since the previous compilation.
      return [sourcePath, serverPath].includes(file) || Object.hasOwn(currentProject.files, file)
        || Object.hasOwn(currentProject.lock, file) || !Object.hasOwn(compilerFiles, file)
        ? String(sourceVersion) : "0";
    },
    getProjectVersion: () => String(sourceVersion),
    getScriptSnapshot: path => {
      const text = read(path);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getDefaultLibFileName: () => `/node_modules/typescript/lib/lib.es2022${serverMode ? "" : ".full"}.d.ts`,
    writeFile: () => { throw new Error("Canvas typechecking does not emit files"); },
    getCurrentDirectory: () => "/",
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: path => read(path) !== undefined, readFile: read,
    directoryExists: path => {
      const prefix = `${normalize(path).replace(/\/$/, "")}/`;
      return [currentProject.files, currentProject.lock, compilerFiles].some(files => Object.keys(files).some(key => key.startsWith(prefix)));
    },
    getDirectories: () => [],
};
let languageService: ts.LanguageService | undefined;

export function typecheckCanvasSource(source: string, project = emptyProject()): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const reachable = new Map<string, string>([[sourcePath, source]]);
  for (const [path, code] of reachable) {
    for (const imported of ts.preProcessFile(code, true, true).importedFiles) {
      if (!imported.fileName.startsWith("./") && !imported.fileName.startsWith("../")) continue;
      const parts = [...path.split("/").slice(0, -1), ...imported.fileName.split("/")];
      const resolved: string[] = [];
      let escaped = false;
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") { if (!resolved.length) { escaped = true; break; } resolved.pop(); }
        else resolved.push(part);
      }
      if (escaped) continue; // The virtual compiler reports the unresolved import.
      const base = resolved.join("/");
      const candidates = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(extension => base + extension), ...[".ts", ".tsx", ".js", ".jsx"].map(extension => `${base}/index${extension}`)];
      // Bundler-mode TS also permits .js import specifiers that point at .ts source.
      if (/\.[cm]?jsx?$/.test(base)) candidates.push(base.replace(/\.[cm]?jsx?$/, ".ts"), base.replace(/\.[cm]?jsx?$/, ".tsx"));
      const found = candidates.find(candidate => Object.hasOwn(project.files, candidate));
      if (found && !reachable.has(found)) reachable.set(found, project.files[found]!);
    }
  }
  for (const [path, code] of reachable) {
    if (path.endsWith(".json")) continue;
    const imports: string[] = [...Object.keys(browserPlugins.paths), "@sidequery/canvas", "react", "react-dom", "react-dom/client", "react-router", "react/jsx-runtime", "react/jsx-dev-runtime"];
    // Permit local paths and declared package subpaths; the virtual compiler still resolves every import.
    for (const match of code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith("./") || specifier.startsWith("../") || Object.keys(project.dependencies).some(name => specifier === name || specifier.startsWith(`${name}/`))) imports.push(specifier);
    }
    const violations = scanCanvasSource(code, imports).filter(item => path === sourcePath || item.kind !== "export");
    diagnostics.push(...sandboxToDiagnostics(path, violations));
  }
  if (diagnostics.length) return diagnostics;
  return typecheckSource(source, false, false, project);
}

export function typecheckCanvasServerSource(source: string, project = emptyProject()): Diagnostic[] {
  return typecheckSource(source, true, false, project);
}

function typecheckSource(source: string, server: boolean, script = false, project = emptyProject()): Diagnostic[] {
  currentProject = normalizeProject(project);
  scriptMode = script;
  serverMode = server;
  currentSource = source;
  sourceVersion++;
  languageService ??= ts.createLanguageService(host);
  const program = languageService.getProgram();
  if (!program) throw new Error("Could not initialize Canvas TypeScript project");
  const diagnostics: Diagnostic[] = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => {
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      return {
        severity: "error" as const,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        file: diagnostic.file?.fileName.replace(/^\//, "") ?? (server ? serverPath : sourcePath),
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
      };
    });
  if (server && !script) diagnostics.push(...validateCanvasServerClass(program));
  return diagnostics;
}

function validateCanvasServerClass(program: ts.Program): Diagnostic[] {
  const file = program.getSourceFiles().find(source => normalize(source.fileName) === serverPath);
  if (!file) return [serverClassDiagnostic()];
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol | undefined) => symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol) : symbol;
  const workersModule = file.statements
    .filter(ts.isImportDeclaration)
    .find(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "cloudflare:workers")
    ?.moduleSpecifier;
  const moduleSymbol = workersModule && checker.getSymbolAtLocation(workersModule);
  const durableObject = resolve(moduleSymbol && checker.getExportsOfModule(moduleSymbol)
    .find(symbol => symbol.name === "DurableObject"));
  const fileSymbol = checker.getSymbolAtLocation(file);
  const canvasServer = resolve(fileSymbol && checker.getExportsOfModule(fileSymbol)
    .find(symbol => symbol.name === "CanvasServer"));
  const declaration = canvasServer?.declarations?.find(node => ts.isClassDeclaration(node) && node.getSourceFile() === file);
  if (!durableObject || !canvasServer || !declaration) return [serverClassDiagnostic(declaration)];

  const seen = new Set<ts.Type>();
  const inheritsDurableObject = (type: ts.Type): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    return (type.getBaseTypes() ?? []).some(base => {
      const symbol = resolve(base.getSymbol());
      return symbol === durableObject || inheritsDurableObject(base);
    });
  };
  return inheritsDurableObject(checker.getDeclaredTypeOfSymbol(canvasServer)) ? [] : [serverClassDiagnostic(declaration)];
}

function serverClassDiagnostic(node?: ts.Node): Diagnostic {
  const position = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return {
    severity: "error",
    message: "Server code must export class CanvasServer extending DurableObject from cloudflare:workers",
    file: serverPath,
    ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
  };
}

let pendingCompilations = 0;
let nextCompilation = 0;
let activeCompilation = 0;

export async function compileCanvasSource(source: string, project = emptyProject()) {
  return queueCompile(source, false, false, project);
}

export async function compileCanvasServerSource(source: string, project = emptyProject()) {
  return queueCompile(source, true, false, project);
}

async function queueCompile(source: string, server: boolean, script = false, project = emptyProject()) {
  // esbuild WASM and semantic checking share the isolate's 128 MiB budget.
  // Serialize builds and bound retained request sources under load.
  if (pendingCompilations >= 8) return { ok: false, diagnostics: [{ severity: "error" as const, message: "Compiler is busy; retry shortly", file: server ? serverPath : sourcePath }] };
  pendingCompilations++;
  const ticket = nextCompilation++;
  // celld 0.4.1 attributes native timers to the request driving a continuation.
  // Wait on this request's own timer instead of another request's promise, so
  // disconnecting a preview cannot cancel the next build's esbuild operations.
  while (ticket !== activeCompilation) await new Promise(resolve => setTimeout(resolve, 5));
  try { return await (script ? compileScript(source, project) : server ? compileServer(source, project) : compileSource(source, project)); }
  finally { activeCompilation++; pendingCompilations--; }
}

async function compileServer(source: string, project: ArtifactProject) {
  const diagnostics = typecheckCanvasServerSource(source, project);
  if (diagnostics.length) return { ok: false, diagnostics };
  try {
    // celld 0.4.1 requires a default Worker export even when only the named
    // Durable Object class is used. Keep that packaging detail out of user code.
    const result = await createWorker({ files: {
      ...project.lock, ...project.files,
      [serverPath]: source,
      "server-entry.ts": `export { CanvasServer } from "./${serverPath}"; export default { fetch() { return new Response("Not found", { status: 404 }); } };`,
    }, entryPoint: "server-entry.ts", target: "es2022", sourcemap: false });
    if (result.warnings?.length) throw new Error(result.warnings.join("\n"));
    const js = result.modules[result.mainModule];
    if (typeof js !== "string") throw new Error("Server compiler did not return JavaScript");
    return { ok: true, js, diagnostics: [] as Diagnostic[] };
  } catch (error) {
    return { ok: false, diagnostics: [{ severity: "error" as const, message: error instanceof Error ? error.message : String(error), file: serverPath }] };
  }
}

async function compileSource(source: string, project: ArtifactProject) {
  const started = performance.now();
  const diagnostics = typecheckCanvasSource(source, project);
  if (diagnostics.length) return { ok: false, diagnostics };
  try {
    const result = await createWorker({
      files: {
        ...project.lock, ...project.files,
        [sourcePath]: source,
        "entry.ts": `import Canvas from "./${sourcePath}"; globalThis.__herdrCanvasRuntime.mount(Canvas);`,
      },
      entryPoint: "entry.ts", target: "es2022",
      jsx: "automatic", minify: false, sourcemap: false,
      define: { "process.env.NODE_ENV": '"production"' },
      virtualModules: {
        "sidequery/canvas": browserRuntime.sdkModule,
        "@sidequery/canvas": browserRuntime.sdkModule,
        "herdr/canvas": browserRuntime.sdkModule,
        "cursor/canvas": browserRuntime.sdkModule,
        ...browserPlugins.modules,
        ...browserRuntime.sharedModules,
      },
    });
    if (result.warnings?.length) throw new Error(result.warnings.join("\n"));
    const js = result.modules[result.mainModule];
    if (typeof js !== "string") throw new Error("Compiler did not return JavaScript");
    // The bundler can silently externalize unresolved imports. The browser
    // sandbox requires a self-contained module, including the JSX runtime.
    const tree = ts.createSourceFile("bundle.js", js, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
    const checkImports = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)
        || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        throw new Error("Compiler produced an unresolved external import");
      }
      ts.forEachChild(node, checkImports);
    };
    checkImports(tree);
    return { ok: true, js: `${browserRuntime.js}\n${js}`, diagnostics: [] as Diagnostic[], elapsedMs: performance.now() - started };
  } catch (error) {
    return { ok: false, diagnostics: [{ severity: "error" as const, message: error instanceof Error ? error.message : String(error), file: sourcePath }] };
  }
}

/** Scripts use Workers globals and can import supported builtins, without the canvas UI restrictions. */
export function compileScriptSource(source: string, project = emptyProject()) { return queueCompile(source, true, true, project); }

async function compileScript(source: string, project: ArtifactProject) {
  const declarations = '\ninterface ScriptEnv { secrets: Record<string, string>; sql: SqlStorage }\ntype __CanvasScriptResult = Response | Promise<Response>;\n';
  const diagnostics = typecheckSource(source + declarations, true, true, project);
  const program = languageService!.getProgram()!;
  const file = program.getSourceFiles().find(item => normalize(item.fileName) === serverPath)!;
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(file);
  const exported = module && checker.getExportsOfModule(module).find(item => item.name === "default");
  const handler = exported && checker.getTypeOfSymbolAtLocation(exported, file);
  const fetch = handler && checker.getPropertyOfType(handler, "fetch");
  const signatures = fetch ? checker.getTypeOfSymbolAtLocation(fetch, file).getCallSignatures() : [];
  if (!signatures.length) diagnostics.push({severity: "error", file: "script.ts", message: "Script must default-export an object with a fetch(request, env, ctx) handler"});
  const resultType = file.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "__CanvasScriptResult");
  if (resultType && signatures.some(signature => !checker.isTypeAssignableTo(checker.getReturnTypeOfSignature(signature), checker.getTypeFromTypeNode(resultType.type)))) {
    diagnostics.push({severity: "error", file: "script.ts", message: "Script fetch handler must return a Response or Promise<Response>"});
  }
  if (diagnostics.length) return {ok: false, diagnostics: diagnostics.map(item => ({...item, file: item.file === serverPath ? "script.ts" : item.file}))};
  try {
    const result = await createWorker({ files: { ...project.lock, ...project.files, "script.ts": source }, entryPoint: "script.ts", target: "es2022", sourcemap: false });
    if (result.warnings?.length) throw new Error(result.warnings.join("\n"));
    const js = result.modules[result.mainModule];
    if (typeof js !== "string") throw new Error("Script compiler did not return JavaScript");
    const tree = ts.createSourceFile("script.js", js, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
    const checkImports = (node: ts.Node) => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && (!ts.isStringLiteral(specifier) || !/^(node:|cloudflare:)/.test(specifier.text))) {
        throw new Error("Script has an unresolved external import; use Workers runtime builtins or self-contained source");
      }
      ts.forEachChild(node, checkImports);
    };
    checkImports(tree);
    return {ok: true, js, diagnostics: [] as Diagnostic[]};
  } catch (error) { return {ok: false, diagnostics: [{severity: "error" as const, file: "script.ts", message: error instanceof Error ? error.message : String(error)}]}; }
}
