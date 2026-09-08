import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { emptyProject, normalizeProject, type ArtifactProject } from "../cloudflare/project";
import { scanArtifactSource } from "./sandbox";
import { sandboxToDiagnostics } from "./diagnostics";
import { assertRegularArtifact, replaceArtifactSource } from "./artifactFile";

export const localProjectPath = (path: string) => `${path}.project.json`;
export function readLocalProject(path: string): ArtifactProject {
  const file = localProjectPath(path);
  if (!existsSync(file)) return emptyProject();
  assertRegularArtifact(file);
  return normalizeProject(JSON.parse(readFileSync(file, "utf8")));
}
export function writeLocalProject(path: string, project: ArtifactProject, exclusive = false): void {
  const file = localProjectPath(path), contents = JSON.stringify(normalizeProject(project), null, 2) + "\n";
  if (exclusive) { writeFileSync(file, contents, { flag: "wx" }); return; }
  if (existsSync(file)) assertRegularArtifact(file);
  replaceArtifactSource(file, contents, existsSync(file) ? readFileSync(file, "utf8") : undefined, "project update");
}
export function projectDiagnostics(path: string, source: string, project: ArtifactProject, publicImports: readonly string[]) {
  return Object.entries({ "artifact.artifact.tsx": source, ...project.files }).flatMap(([file, text]) => {
    if (file.endsWith(".json")) return [];
    const imports = [...text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map(match => match[1]!);
    const allowed = imports.filter(specifier => specifier.startsWith("./") || specifier.startsWith("../") || Object.keys(project.dependencies).some(name => specifier === name || specifier.startsWith(`${name}/`)));
    return sandboxToDiagnostics(file === "artifact.artifact.tsx" ? path : file,
      scanArtifactSource(text, [...publicImports, ...allowed]).filter(item => file === "artifact.artifact.tsx" || item.kind !== "export"));
  });
}
/** Materialize only the immutable snapshot. Never install packages or execute lifecycle scripts. */
export function materializeProject(source: string, input: ArtifactProject) {
  const project = normalizeProject(input), directory = realpathSync(mkdtempSync(join(tmpdir(), "artifact-project-")));
  try {
    for (const [file, contents] of Object.entries({ ...project.lock, ...project.files, "artifact.artifact.tsx": source })) {
      const path = join(directory, file);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
    }
    return { path: join(directory, "artifact.artifact.tsx"), directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
