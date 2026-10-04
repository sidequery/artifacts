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

export type ArtifactSelection = { name?: string; workspace?: string; version_id?: string; route?: string; kind?: "artifact" | "script"; tab?: "preview" | "source" };

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
  if ((!name && !version_id) || !route.startsWith("/") || route.startsWith("//") || route.includes("\\") || (kind && !["artifact", "script"].includes(kind)) || (tab && !["preview", "source"].includes(tab))) return null;
  return { name: version_id ? undefined : name, workspace, version_id, route, ...(kind ? { kind: kind as "artifact" | "script" } : {}), ...(tab ? { tab: tab as "preview" | "source" } : {}) };
}

export async function fetchArtifactPreview(app: App, selection: ArtifactSelection): Promise<ArtifactAppPayload> {
  const { route: _route, kind: _kind, tab: _tab, ...args } = selection;
  const result = await app.callServerTool({ name: "artifacts_preview", arguments: args });
  if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Unable to open artifact");
  const artifact = result._meta?.artifact as ArtifactAppPayload | undefined;
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

export function createGalleryTransport(app: App): GalleryTransport {
  return {
    async tool(workspace, tool, args) {
      return resultValue(await app.callServerTool({ name: "artifacts_tool", arguments: { workspace, tool, arguments: args } }));
    },
    async loadSource(sourceUrl, signal) {
      signal?.throwIfAborted();
      const params = new URL(sourceUrl, "https://artifacts.invalid").searchParams;
      const selection = params.get("version_id") ? { version_id: params.get("version_id")! } : { name: params.get("name")! };
      const result = await app.callServerTool({ name: "artifacts_source", arguments: { workspace: params.get("workspace")!, kind: params.get("kind") === "script" ? "script" : "artifact", ...selection } });
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
  const transport = createGalleryTransport(app);
  const gallery = workspaceGallery(initial);
  let current = options;
  let refreshKey = 0;
  const search = async (query: string, offset: number) => {
    const result = await app.callServerTool({ name: "artifacts_search", arguments: { query, offset, view: "library" } });
    if (result.isError) resultValue(result);
    const payload = result._meta?.workspace as ArtifactWorkspacePayload | undefined;
    if (!payload) throw new Error("The server returned no library catalog");
    return workspaceGallery(payload);
  };
  const render = () => reactRoot.render(createElement(GalleryWorkspace, { initial: gallery, view: initial.view, transport, search, ...current, refreshKey }));
  render();
  return {
    update(value: Partial<WorkspaceOptions>) { current = { ...current, ...value }; render(); },
    refresh() { refreshKey++; render(); },
    dispose() { reactRoot.unmount(); },
  };
}
