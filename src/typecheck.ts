import { readFileSync } from "node:fs";
import ts from "typescript";

import { sandboxToDiagnostics, type Diagnostic } from "./diagnostics";
import { PLUGIN_ROOT, SDK_ENTRY } from "./paths";
import { scanCanvasSource } from "./sandbox";
import { relative } from "node:path";

export function typecheckCanvas(canvasPath: string): Diagnostic[] {
  const source = readFileSync(canvasPath, "utf8");
  const violations = scanCanvasSource(source);
  if (violations.length > 0) {
    return sandboxToDiagnostics(canvasPath, violations);
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    baseUrl: PLUGIN_ROOT,
    paths: {
      "herdr/canvas": [relative(PLUGIN_ROOT, SDK_ENTRY)],
      "cursor/canvas": [relative(PLUGIN_ROOT, SDK_ENTRY)],
    },
  };

  const host = ts.createCompilerHost(compilerOptions);
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => ({
      resolvedModule: resolveSpecifier(literal.text, containingFile, compilerOptions, host),
    }));

  const program = ts.createProgram({
    rootNames: [canvasPath],
    options: compilerOptions,
    host,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => toDiagnostic(diagnostic, canvasPath));
}

function resolveSpecifier(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
): ts.ResolvedModuleFull | undefined {
  if (specifier === "herdr/canvas" || specifier === "cursor/canvas") {
    return {
      resolvedFileName: SDK_ENTRY,
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
  }
  const direct = ts.resolveModuleName(specifier, containingFile, options, host);
  if (direct.resolvedModule) {
    return direct.resolvedModule;
  }
  const fromSdk = ts.resolveModuleName(specifier, SDK_ENTRY, options, host);
  if (fromSdk.resolvedModule) {
    return fromSdk.resolvedModule;
  }
  const fromRoot = ts.resolveModuleName(specifier, PLUGIN_ROOT + "/index.ts", options, host);
  return fromRoot.resolvedModule;
}

function toDiagnostic(diagnostic: ts.Diagnostic, canvasPath: string): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      severity: "error",
      message,
      file: diagnostic.file.fileName,
      line: line + 1,
      column: character + 1,
    };
  }
  return { severity: "error", message, file: canvasPath };
}
