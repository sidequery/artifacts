import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GalleryData } from "../src/gallery/types";
import { artifactResourceUri, workspaceResult } from "../src/mcp/workspace-contract";

/** Offsets refer to catalog pages, including pages with zero matching names. */
export async function workspaceTool(service: { workspace: string; gallery(all: boolean, offset?: number): Promise<GalleryData> }, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const view = name === "artifacts_working" || args.view === "working" ? "working" : "library";
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const query = typeof args.query === "string" ? args.query.toLocaleLowerCase() : "";
  const gallery = await service.gallery(view === "library", offset);
  const items = gallery.artifacts.filter(item => item.kind !== "script" && item.name.toLocaleLowerCase().includes(query));
  if (name === "artifacts_mentions") {
    // Composer search has no pagination UI: scan catalog pages until enough
    // matches exist, while repeating the gallery's permission-filtered reads.
    let page = gallery;
    const matches = [...items];
    while (matches.length < 100 && page.nextOffset != null) {
      page = await service.gallery(true, page.nextOffset);
      matches.push(...page.artifacts.filter(item => item.kind !== "script" && item.name.toLocaleLowerCase().includes(query)));
    }
    const links = matches.slice(0, 100).map(item => ({ type: "resource_link" as const, uri: artifactResourceUri(item, item.working ? undefined : item.versions[0]?.id), name: item.name, mimeType: "application/json", description: `React artifact in workspace ${item.workspace}` }));
    return { content: links, structuredContent: { items: links } };
  }
  return workspaceResult({ view, workspace: gallery.workspace, items, nextOffset: gallery.nextOffset ?? null });
}
