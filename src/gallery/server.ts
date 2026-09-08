import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRegularArtifact, artifactIdFromFile, ensureArtifactFileName, resolveArtifactFile, listArtifactFiles } from "../artifactFile";
import type { ArtifactHistory } from "../history";
import { PLUGIN_ROOT } from "../paths";
import type { GalleryArtifact, GalleryData } from "./types";

export function galleryData(history: ArtifactHistory, workspace: string, all: boolean): GalleryData {
  const artifacts = new Map<string, GalleryArtifact>();
  const key = (dir: string, name: string) => JSON.stringify([dir, name]);
  for (const version of history.list(all ? undefined : workspace)) {
    const id = key(version.workspace, version.name);
    let artifact = artifacts.get(id);
    if (!artifact) {
      artifact = { key: id, name: version.name, workspace: version.workspace, working: false, versions: [] };
      artifacts.set(id, artifact);
    }
    artifact.versions.push({ id: version.version_id, revision: version.revision, createdAt: version.created_at, reason: version.reason, serveCount: version.serve_count });
  }
  for (const path of listArtifactFiles(workspace)) {
    try { assertRegularArtifact(path); } catch { continue; }
    const name = artifactIdFromFile(path);
    const id = key(workspace, name);
    const artifact = artifacts.get(id) ?? { key: id, name, workspace, working: false, versions: [] };
    artifact.working = true;
    artifacts.set(id, artifact);
  }
  return { workspace, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)) };
}

export function workingSource(workspace: string, name: string) {
  ensureArtifactFileName(name);
  const path = resolveArtifactFile(name, workspace);
  assertRegularArtifact(path);
  return { path, name: artifactIdFromFile(path), source: readFileSync(path, "utf8") };
}

export async function galleryBundle(): Promise<string> {
  const result = await Bun.build({ entrypoints: [join(PLUGIN_ROOT, "src/gallery/client.tsx")], target: "browser", format: "esm", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!result.success) throw new Error(`gallery build failed: ${result.logs.join("\n")}`);
  return (await Promise.all(result.outputs.map(output => output.text()))).join("\n");
}

export function galleryHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sidequery Artifacts library</title><style>html,body{margin:0;background:#101719;color:#e9eeee;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/gallery.js"></script></body></html>`;
}
