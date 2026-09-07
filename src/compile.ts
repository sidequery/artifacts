import type { BunPlugin } from "bun";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { sandboxToDiagnostics, type Diagnostic } from "./diagnostics";
import { PLUGIN_ROOT, SDK_ENTRY, WRAPPER_ENTRY } from "./paths";
import { scanCanvasSource } from "./sandbox";

const requireFromPlugin = createRequire(join(PLUGIN_ROOT, "package.json"));

export type CompileResult = {
  ok: boolean;
  js?: string;
  diagnostics: Diagnostic[];
};

export function canvasAliasPlugin(canvasPath: string, source?: string): BunPlugin {
  const absCanvas = resolve(canvasPath);
  return {
    name: "herdr-canvas-alias",
    setup(build) {
      if (source !== undefined) {
        build.onLoad({ filter: /\.canvas\.tsx$/ }, (args) => args.path === absCanvas ? { contents: source, loader: "tsx" } : undefined);
      }
      build.onResolve({ filter: /^(sidequery\/canvas|herdr\/canvas|cursor\/canvas)$/ }, () => ({
        path: SDK_ENTRY,
      }));
      build.onResolve({ filter: /^herdr-canvas-entry$/ }, () => ({
        path: absCanvas,
      }));
      build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
        path: requireFromPlugin.resolve(args.path),
      }));
    },
  };
}

export async function compileCanvas(canvasPath: string, snapshot?: string): Promise<CompileResult> {
  const absCanvas = resolve(canvasPath);
  const source = snapshot ?? readFileSync(absCanvas, "utf8");
  const violations = scanCanvasSource(source);
  if (violations.length > 0) {
    return {
      ok: false,
      diagnostics: sandboxToDiagnostics(absCanvas, violations),
    };
  }

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [WRAPPER_ENTRY],
      target: "browser",
      format: "esm",
      minify: false,
      sourcemap: "none",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      plugins: [canvasAliasPlugin(absCanvas, source)],
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          file: absCanvas,
        },
      ],
    };
  }

  if (!result.success) {
    return {
      ok: false,
      diagnostics: result.logs.map((log) => ({
        severity: "error" as const,
        message: String(log),
        file: absCanvas,
      })),
    };
  }

  const js = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n");
  return { ok: true, js, diagnostics: [] };
}
