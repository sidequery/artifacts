import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GALLERY_TOOL_NAMES } from "../src/mcp/gallery-contract";
import { toolErrorResult } from "../src/mcp/tool-result";

type Selection = { workspace?: string; name?: string; version_id?: string };
type Source = { name: string; source: string; server_source?: string | null };
type SourceService = {
  snapshot(selection: Selection): Promise<Source>;
  scriptReadSource(selection: Selection): Promise<Source>;
};

export async function gallerySource(service: SourceService, args: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof args.workspace !== "string" || !args.workspace.trim() || (args.kind !== "artifact" && args.kind !== "script")) throw new Error("Select a workspace and artifact or script kind");
  if ((typeof args.name === "string") === (typeof args.version_id === "string")) throw new Error("Select name or version_id, but not both");
  const selection = { workspace: args.workspace, ...(typeof args.name === "string" ? { name: args.name } : { version_id: args.version_id as string }) };
  const source = args.kind === "script" ? await service.scriptReadSource(selection) : await service.snapshot(selection);
  const payload = { ...source, kind: args.kind, workspace: args.workspace, server_source: source.server_source ?? null };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

export async function galleryAction(service: { callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> }, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!(GALLERY_TOOL_NAMES as readonly unknown[]).includes(args.tool)) throw new Error("Unsupported gallery action");
  if (typeof args.workspace !== "string" || !args.workspace.trim()) throw new Error("Select a workspace");
  if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new Error("Gallery arguments must be an object");
  if (Object.hasOwn(args.arguments, "workspace")) throw new Error("Workspace must be selected in the gallery action envelope");
  try {
    return await service.callTool(args.tool as string, { ...args.arguments, workspace: args.workspace });
  } catch (error) {
    return toolErrorResult(error);
  }
}
