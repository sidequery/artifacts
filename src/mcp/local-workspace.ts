import { resolve } from "node:path";
import type { ArtifactService } from "../service";
import { artifactResourceUri, type ArtifactWorkspaceItem, type ArtifactWorkspacePayload } from "./workspace-contract";

export function localWorkspace(service: ArtifactService, view: "library" | "working", query = "", offset = 0): ArtifactWorkspacePayload {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
  if (typeof query !== "string" || query.length > 200) throw new Error("query must be at most 200 characters");
  const workspace = resolve(service.artifactsDir);
  const items = new Map<string, ArtifactWorkspaceItem>();
  for (const file of service.list()) items.set(file.id, { name: file.id, workspace, working: true, versions: [] });
  for (const version of service.history()) {
    const item = items.get(version.name) ?? { name: version.name, workspace, working: false, versions: [] };
    item.versions.push({ id: version.version_id, revision: version.revision, createdAt: version.created_at });
    items.set(item.name, item);
  }
  const filtered = [...items.values()].filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { view, workspace, items: filtered.slice(offset, offset + 100), nextOffset: filtered.length > offset + 100 ? offset + 100 : null };
}

export function localMentions(service: ArtifactService, query: string) {
  return localWorkspace(service, "library", query).items.map(item => ({
    type: "resource_link" as const, uri: artifactResourceUri(item, item.working ? undefined : item.versions[0]?.id),
    name: item.name, title: item.name, mimeType: "application/json",
    description: "React artifact source and revision metadata in the connected workspace",
  }));
}

export function localResource(service: ArtifactService, uri: string) {
  const url = new URL(uri);
  if (url.protocol !== "artifact:" || url.hostname !== "project" || url.pathname || url.hash
    || [...url.searchParams.keys()].some(key => !["workspace", "name", "version_id"].includes(key))) throw new Error("unknown artifact resource");
  const workspace = url.searchParams.get("workspace");
  const name = url.searchParams.get("name");
  const versionId = url.searchParams.get("version_id");
  if (workspace !== resolve(service.artifactsDir) || !name) throw new Error("artifact resource is outside this workspace");
  if (versionId) {
    const saved = service.version(versionId);
    if (saved.name !== name) throw new Error("artifact resource version does not match its name");
    return { name, workspace, version_id: saved.id, revision: saved.revision, source: saved.source, source_hash: saved.source_hash };
  }
  const current = service.readRange(name, { end_line: Number.MAX_SAFE_INTEGER });
  return { name, workspace, source: current.source, source_hash: current.source_hash };
}
