import { useState, type ReactNode } from "react";
import type { GalleryItem } from "./types";

type Folder<T> = { path: string; name: string; folders: Map<string, Folder<T>>; artifacts: T[] };

/** Trim a shared local parent, retaining the actual containing folder names. */
export function artifactFolders<T extends GalleryItem>(artifacts: T[], workspaces: string[]) {
  const paths = workspaces.map(path => path.replaceAll("\\", "/").split("/").filter(Boolean));
  let common = 0;
  if (workspaces.every(path => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
    while (paths.length && paths.every(parts => common < parts.length - 1 && parts[common] === paths[0]![common])) common++;
  }
  const root: Folder<T> = { path: "", name: "", folders: new Map(), artifacts: [] };
  for (const artifact of artifacts) {
    const parts = artifact.workspace === "default" ? [] : artifact.workspace.replaceAll("\\", "/").split("/").filter(Boolean).slice(common);
    let folder = root;
    for (const name of parts) {
      const path = `${folder.path}/${name}`;
      if (!folder.folders.has(name)) folder.folders.set(name, { path, name, folders: new Map(), artifacts: [] });
      folder = folder.folders.get(name)!;
    }
    folder.artifacts.push(artifact);
  }
  return root;
}

export function ArtifactFolders<T extends GalleryItem>({ artifacts, workspaces, searching, renderArtifact }: {
  artifacts: T[]; workspaces: string[]; searching: boolean;
  renderArtifact: (artifact: T, depth: number) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const root = artifactFolders(artifacts, workspaces);
  function contents(folder: Folder<T>, depth: number): ReactNode {
    return <>
      {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => {
        const expanded = searching || !collapsed.has(child.path);
        return <div key={child.path}>
          <button type="button" className="folder-row" style={{ paddingLeft: depth * 14 + 10 }} aria-expanded={expanded}
            onClick={() => setCollapsed(previous => {
              const next = new Set(previous);
              if (next.has(child.path)) next.delete(child.path); else next.add(child.path);
              return next;
            })}>
            <span className="folder-chevron" aria-hidden="true" /><span className="artifact-name">{child.name}</span>
          </button>
          <div hidden={!expanded}>{contents(child, depth + 1)}</div>
        </div>;
      })}
      {folder.artifacts.map(artifact => renderArtifact(artifact, depth))}
    </>;
  }
  return contents(root, 0);
}
