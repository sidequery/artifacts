import { createWorker } from "@cloudflare/worker-bundler";
import ts from "../dist/cloudflare/typescript.js";
import files from "../dist/cloudflare/compiler-files.json";
import browserRuntime from "../dist/cloudflare/browser-runtime.json";
import { sandboxToDiagnostics, type Diagnostic } from "../src/diagnostics";
import { scanCanvasSource } from "../src/sandbox";

const sourcePath = "canvas.canvas.tsx";
const sdkPath = "src/sdk/index.ts";
const compilerFiles: Record<string, string> = files;
const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true,
    allowSyntheticDefaultImports: true, baseUrl: "/",
    paths: { "herdr/canvas": [sdkPath], "cursor/canvas": [sdkPath] },
    types: [],
};
const normalize = (path: string) => path.replace(/^\//, "");
let currentSource = "";
let sourceVersion = 0;
const read = (path: string) => normalize(path) === sourcePath ? currentSource : compilerFiles[normalize(path)];
// A single bounded language-service project retains the immutable SDK/lib ASTs.
// Typechecking is synchronous, so overlapping requests cannot observe another
// source while checking. No per-user project/program cache accumulates here.
const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [`/${sourcePath}`],
    getScriptVersion: path => normalize(path) === sourcePath ? String(sourceVersion) : "0",
    getProjectVersion: () => String(sourceVersion),
    getScriptSnapshot: path => {
      const text = read(path);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getDefaultLibFileName: () => "/node_modules/typescript/lib/lib.es2022.full.d.ts",
    writeFile: () => { throw new Error("Canvas typechecking does not emit files"); },
    getCurrentDirectory: () => "/",
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    fileExists: path => read(path) !== undefined, readFile: read,
    directoryExists: path => Object.keys(compilerFiles).some(key => key.startsWith(`${normalize(path).replace(/\/$/, "")}/`)),
    getDirectories: () => [],
};
let languageService: ts.LanguageService | undefined;

export function typecheckCanvasSource(source: string): Diagnostic[] {
  const violations = scanCanvasSource(source);
  if (violations.length) return sandboxToDiagnostics(sourcePath, violations);
  currentSource = source;
  sourceVersion++;
  languageService ??= ts.createLanguageService(host);
  const program = languageService.getProgram();
  if (!program) throw new Error("Could not initialize Canvas TypeScript project");
  return ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => {
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      return {
        severity: "error" as const,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        file: diagnostic.file?.fileName.replace(/^\//, "") ?? sourcePath,
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
      };
    });
}

let compilationTail: Promise<unknown> = Promise.resolve();
let pendingCompilations = 0;

export async function compileCanvasSource(source: string) {
  // esbuild WASM and semantic checking share the isolate's 128 MiB budget.
  // Serialize builds and bound retained request sources under load.
  if (pendingCompilations >= 8) return { ok: false, diagnostics: [{ severity: "error" as const, message: "Compiler is busy; retry shortly", file: sourcePath }] };
  pendingCompilations++;
  const result = compilationTail.then(() => compileSource(source));
  compilationTail = result.catch(() => undefined);
  try { return await result; } finally { pendingCompilations--; }
}

async function compileSource(source: string) {
  const started = performance.now();
  const diagnostics = typecheckCanvasSource(source);
  if (diagnostics.length) return { ok: false, diagnostics };
  try {
    const result = await createWorker({
      files: {
        [sourcePath]: source,
        "entry.ts": `import Canvas from "./${sourcePath}"; globalThis.__herdrCanvasRuntime.mount(Canvas);`,
      },
      entryPoint: "entry.ts", target: "es2022",
      jsx: "automatic", minify: false, sourcemap: false,
      define: { "process.env.NODE_ENV": '"production"' },
      virtualModules: {
        "herdr/canvas": browserRuntime.sdkModule,
        "cursor/canvas": browserRuntime.sdkModule,
        "react/jsx-runtime": "export const { jsx, jsxs, Fragment } = globalThis.__herdrCanvasRuntime.jsx;",
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
