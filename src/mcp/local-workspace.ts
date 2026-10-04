import { resolve } from "node:path";
import type { ArtifactService } from "../service";
import { artifactResourceUri, parseArtifactResourceUri, type ArtifactWorkspaceItem, type ArtifactWorkspacePayload } from "./workspace-contract";
import { readLocalServer } from "../localProject";
import { projectRevision, emptyProject } from "../../cloudflare/project";

export function localWorkspace(service: ArtifactService, view: "library" | "working", query = "", offset = 0): ArtifactWorkspacePayload {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
  if (typeof query !== "string" || query.length > 200) throw new Error("query must be at most 200 characters");
  const workspace = resolve(service.artifactsDir);
  const items = new Map<string, ArtifactWorkspaceItem>();
  for (const file of service.list()) items.set(file.id, { name: file.id, workspace, kind: "artifact", working: true, versions: [] });
  for (const version of service.history()) {
    const item = items.get(version.name) ?? { name: version.name, workspace, kind: "artifact", working: false, versions: [] };
    item.versions.push({ id: version.version_id, revision: version.revision, createdAt: version.created_at, reason: version.reason, serveCount: version.serve_count });
    items.set(item.name, item);
  }
  const filtered = [...items.values()].filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const page = filtered.slice(offset, offset + 100);
  const nextOffset = filtered.length > offset + 100 ? offset + 100 : null;
  return { view, workspace, items: page, nextOffset, gallery: { workspace, nextOffset, capabilities: { editing: false }, artifacts: page.map(item => ({ ...item, key: JSON.stringify([workspace, item.name]), versions: item.versions.map(version => ({ ...version, reason: version.reason ?? "saved", serveCount: version.serveCount ?? 0 })) })) } };
}

export function localMentions(service: ArtifactService, query: string) {
  return localWorkspace(service, "library", query).items.map(item => ({
    type: "resource_link" as const, uri: artifactResourceUri(item, item.working ? undefined : item.versions[0]?.id),
    name: item.name, title: `${item.name} · artifact · ${item.workspace}`, mimeType: "application/json",
    description: "React artifact source and revision metadata in the connected workspace",
  }));
}

export function localResource(service: ArtifactService, uri: string) {
  const { workspace, name, kind, version_id } = parseArtifactResourceUri(uri);
  if (workspace !== resolve(service.artifactsDir)) throw new Error("artifact resource is outside this workspace");
  if (kind !== "artifact") throw new Error("Scripts require the hosted artifact service");
  if (version_id) {
    const saved = service.version(version_id);
    if (saved.name !== name) throw new Error("artifact resource version does not match its name");
    const server_source = saved.server_source ?? null;
    const project = saved.project ?? emptyProject();
    return { ...saved, name, workspace, kind, version_id: saved.id, server_source, project, revision_token: projectRevision(saved.source, server_source, project) };
  }
  const current = service.readRange(name, { end_line: Number.MAX_SAFE_INTEGER });
  const server_source = readLocalServer(current.path);
  return { ...current, name, workspace, kind, server_source, revision_token: projectRevision(current.source, server_source, current.project) };
}

export function localSource(service: ArtifactService, args: Record<string, unknown>) {
  if (args.workspace !== resolve(service.artifactsDir)) throw new Error("artifact resource is outside this workspace");
  if (args.kind !== "artifact") throw new Error("Scripts require the hosted artifact service");
  if ((typeof args.name === "string") === (typeof args.version_id === "string")) throw new Error("Select name or version_id, but not both");
  const name = typeof args.name === "string" ? args.name : service.version(args.version_id as string).name;
  return localResource(service, artifactResourceUri({ name, workspace: args.workspace as string }, args.version_id as string | undefined));
}
