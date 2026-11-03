import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { ArtifactWorkspacePayload } from "../mcp/workspace-contract";
import type { ArtifactAppPayload } from "../mcp/app-contract";
import type { GalleryData } from "../gallery/types";
import { GalleryWorkspace } from "../gallery/workspace";
import { GalleryToolError, type GalleryTransport, type MutationResult } from "../gallery/transport";
import type { SourceSnapshot } from "../gallery/drafts";
import { editableProject } from "../gallery/project-editor";

export type ArtifactSelection = { name?: string; workspace?: string; library_scope?: "private" | "team"; version_id?: string; event_id?: string; route?: string; kind?: "artifact" | "script"; tab?: "preview" | "source" };

/** Deep links contain authenticated selectors, never file-transfer credentials. */
export function parseArtifactDeepLink(value: string): ArtifactSelection | null {
  if (/[\\\s#]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, "https://artifacts.invalid"); } catch { return null; }
  if (url.origin !== "https://artifacts.invalid" || url.pathname !== "/artifact") return null;
  const name = url.searchParams.get("name") ?? undefined;
  const version_id = url.searchParams.get("version_id") ?? undefined;
  const workspace = url.searchParams.get("workspace") ?? undefined;
  const route = url.searchParams.get("route") ?? "/";
  const kind = url.searchParams.get("kind");
  const tab = url.searchParams.get("tab");
  const library_scope = url.searchParams.get("library_scope");
  if (library_scope !== null && library_scope !== "private" && library_scope !== "team") return null;
  if ((!name && !version_id) || !route.startsWith("/") || route.startsWith("//") || route.includes("\\") || (kind && !["artifact", "script"].includes(kind)) || (tab && !["preview", "source"].includes(tab))) return null;
  return { name: version_id ? undefined : name, workspace, version_id, route, ...(library_scope ? { library_scope } : {}), ...(kind ? { kind: kind as "artifact" | "script" } : {}), ...(tab ? { tab: tab as "preview" | "source" } : {}) };
}

export async function fetchArtifactPreview(app: App, selection: ArtifactSelection): Promise<ArtifactAppPayload> {
  const { route: _route, kind: _kind, tab: _tab, ...args } = selection;
  const result = await app.callServerTool({ name: "artifacts_preview", arguments: args });
  if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Unable to open artifact");
  const artifact = (result._meta?.artifact ?? result.structuredContent?.appPreview) as ArtifactAppPayload | undefined;
  if (!artifact?.js) throw new Error("The server returned no artifact preview");
  return artifact;
}

/** Older server pages remain readable during a server/plugin rollout. */
export function workspaceGallery(payload: ArtifactWorkspacePayload): GalleryData {
  if (payload.gallery) return payload.gallery;
  return { workspace: payload.workspace, nextOffset: payload.nextOffset, artifacts: payload.items.map(item => ({
    ...item, key: JSON.stringify([item.workspace, item.name]),
    versions: item.versions.map(version => ({ reason: "saved", serveCount: 0, ...version })),
  })) };
}

function resultValue(result: Awaited<ReturnType<App["callServerTool"]>>) {
  const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  let value: unknown = result.structuredContent;
  if (value === undefined && text) { try { value = JSON.parse(text); } catch { value = text; } }
  if (result.isError) {
    const detail = typeof value === "object" && value !== null ? value as MutationResult & { status?: number } : undefined;
    throw new GalleryToolError(detail?.error ?? text ?? "Artifact operation failed", detail?.status ?? 500, detail);
  }
  return value;
}

export function createGalleryTransport(app: App, scope?: "private" | "team"): GalleryTransport {
  const library = scope ? { library_scope: scope } : {};
  return {
    async tool(workspace, tool, args) {
      return resultValue(await app.callServerTool({ name: "artifacts_tool", arguments: { workspace, tool, arguments: args, ...library } }));
    },
    async loadSource(sourceUrl, signal) {
      signal?.throwIfAborted();
      const params = new URL(sourceUrl, "https://artifacts.invalid").searchParams;
      const selection = params.get("version_id") ? { version_id: params.get("version_id")! } : { name: params.get("name")! };
      const result = await app.callServerTool({ name: "artifacts_source", arguments: { workspace: params.get("workspace")!, kind: params.get("kind") === "script" ? "script" : "artifact", ...selection, ...library } });
      signal?.throwIfAborted();
      const snapshot = resultValue(result) as SourceSnapshot;
      if (typeof snapshot?.source !== "string" || !snapshot.project) throw new Error("The server returned an incomplete project snapshot");
      return { ...snapshot, project: editableProject(snapshot.project) };
    },
  };
}

type WorkspaceProps = Parameters<typeof GalleryWorkspace>[0];
export type WorkspaceOptions = Pick<WorkspaceProps, "renderPreview" | "attach" | "attachedVersionId" | "selection" | "onSelectionChange" | "openProduct" | "openLink" | "askCreate">;

export function mountWorkspace(root: HTMLElement, app: App, initial: ArtifactWorkspacePayload, options: WorkspaceOptions) {
  const reactRoot = createRoot(root);
  let gallery = workspaceGallery(initial);
  let scope = gallery.libraryScope;
  let current = options;
  let refreshKey = 0;
  let libraryRequest = 0;
  let disposed = false;
  const searchScope = async (query: string, offset: number, selectedScope = scope) => {
    const result = await app.callServerTool({ name: "artifacts_search", arguments: { query, offset, view: "library", ...(selectedScope ? { library_scope: selectedScope } : {}) } });
    if (result.isError) resultValue(result);
    const payload = (result._meta?.workspace ?? result.structuredContent?.appWorkspace) as ArtifactWorkspacePayload | undefined;
    if (!payload) throw new Error("The server returned no library catalog");
    return workspaceGallery(payload);
  };
  let transport = createGalleryTransport(app, scope);
  const initialScope = scope;
  let search = (query: string, offset: number) => searchScope(query, offset, initialScope);
  const changeLibrary = async (selectedScope: "private" | "team", selection?: ArtifactSelection) => {
    const generation = ++libraryRequest;
    const page = await searchScope("", 0, selectedScope);
    if (disposed || generation !== libraryRequest) return;
    scope = selectedScope; gallery = page;
    current = { ...current, selection };
    transport = createGalleryTransport(app, scope);
    // Capture the selected scope so requests from the old view cannot change
    // libraries halfway through pagination or a save.
    search = (query, offset) => searchScope(query, offset, selectedScope);
    render();
  };
  const render = () => reactRoot.render(createElement(GalleryWorkspace, { key: gallery.libraryScope, initial: gallery, view: initial.view, transport, search, ...current,
    ...(gallery.libraryScope ? { onLibraryChange: changeLibrary } : {}), refreshKey }));
  render();
  const ready = options.selection?.library_scope && options.selection.library_scope !== scope
    ? changeLibrary(options.selection.library_scope, options.selection) : Promise.resolve();
  return {
    ready,
    async update(value: Partial<WorkspaceOptions>) {
      if (value.selection?.library_scope && value.selection.library_scope !== scope) {
        await changeLibrary(value.selection.library_scope, value.selection);
        return;
      }
      current = { ...current, ...value }; render();
    },
    refresh() { refreshKey++; render(); },
    dispose() { disposed = true; ++libraryRequest; reactRoot.unmount(); },
  };
}
