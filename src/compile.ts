import { readLocalProject, materializeProject, projectDiagnostics } from "./localProject";
import type { ArtifactProject } from "../cloudflare/project";
import type { BunPlugin } from "bun";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { type Diagnostic } from "./diagnostics";
import { PLUGIN_ROOT, SDK_ENTRY, WRAPPER_ENTRY } from "./paths";
import { loadBrowserPlugins } from "./plugins/browser";
import type { BrowserPlugins } from "./plugins/types";

const requireFromPlugin = createRequire(join(PLUGIN_ROOT, "package.json"));

export type CompileResult = {
  ok: boolean;
  js?: string;
  diagnostics: Diagnostic[];
};

export function artifactAliasPlugin(artifactPath: string, source?: string, plugins: BrowserPlugins = loadBrowserPlugins()): BunPlugin {
  const absArtifact = resolve(artifactPath);
  return {
    name: "artifacts-alias",
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => Object.hasOwn(plugins.paths, args.path)
        ? { path: args.path, namespace: "artifact-browser-plugin" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "artifact-browser-plugin" }, args => ({
        contents: plugins.modules[args.path], loader: "js", resolveDir: PLUGIN_ROOT,
      }));
      if (source !== undefined) {
        build.onLoad({ filter: /\.artifact\.tsx$/ }, (args) => args.path === absArtifact ? { contents: source, loader: "tsx" } : undefined);
      }
      build.onResolve({ filter: /^((@sidequery|sidequery)\/(artifacts|canvas)|(herdr|cursor)\/canvas)$/ }, () => ({
        path: SDK_ENTRY,
      }));
      build.onResolve({ filter: /^artifacts-entry$/ }, () => ({
        path: absArtifact,
      }));
      // Resolve shared runtimes to one package entry. Bun plugin builds can drop
      // React Router ESM re-export chunks; the package CJS entry preserves them.
      build.onResolve({ filter: /^(react|react-dom|react-router)(\/.*)?$/ }, (args) => ({
        path: requireFromPlugin.resolve(args.path),
      }));
      // User modules resolve only inside the materialized snapshot, never host files.
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.importer.startsWith(dirname(absArtifact) + "/")) return;
        const path = Bun.resolveSync(args.path, args.resolveDir || dirname(args.importer));
        if (!path.startsWith(dirname(absArtifact) + "/")) throw new Error(`import escapes artifact project: ${args.path}`);
        return { path };
      });

    },
  };
}

export async function compileArtifact(artifactPath: string, snapshot?: string, plugins: BrowserPlugins = loadBrowserPlugins(), project: ArtifactProject = readLocalProject(artifactPath)): Promise<CompileResult> {
  const absArtifact = resolve(artifactPath);
  const source = snapshot ?? readFileSync(absArtifact, "utf8");
  const violations = projectDiagnostics(absArtifact, source, project, Object.keys(plugins.paths));
  if (violations.length > 0) {
    return {
      ok: false,
      diagnostics: violations,
    };
  }

  const snapshotProject = materializeProject(source, project);
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
      plugins: [artifactAliasPlugin(snapshotProject.path, source, plugins)],
    });
  } catch (error) {
    snapshotProject.dispose();
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: error instanceof AggregateError ? [...error.errors].map(String).join("\n") : error instanceof Error ? error.message : String(error),
          file: absArtifact,
        },
      ],
    };
  }

  snapshotProject.dispose();
  if (!result.success) {
    return {
      ok: false,
      diagnostics: result.logs.map((log) => ({
        severity: "error" as const,
        message: String(log),
        file: absArtifact,
      })),
    };
  }

  const js = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n");
  return { ok: true, js, diagnostics: [] };
}
