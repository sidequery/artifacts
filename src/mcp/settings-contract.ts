import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { GalleryData } from "../gallery/types";

export const ARTIFACTS_SETTINGS_CAPABILITY = { readTool: "artifacts_settings_read", updateTool: "artifacts_settings_update" };
const emptySchema = { type: "object" as const, properties: {}, additionalProperties: false };
const appOnly = { ui: { visibility: ["app"] } };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** Connection configuration belongs to the configured MCP server. Native
 * settings expose that context and real actions without pretending to edit it. */
export const ARTIFACTS_SETTINGS_TOOLS: Tool[] = [
  { name: "artifacts_settings_read", title: "Artifacts connection", description: "Read the current connection and workspace settings actions.",
    annotations: readOnly, _meta: appOnly, inputSchema: emptySchema,
    outputSchema: { type: "object", properties: { schema: { type: "object" }, layout: { type: "array" }, values: { type: "object" } }, required: ["schema", "values"] } },
  { name: "artifacts_settings_update", description: "Acknowledge native settings updates. Connection configuration is managed by the MCP host.",
    annotations: readOnly, _meta: appOnly, inputSchema: { type: "object", properties: { set: emptySchema }, required: ["set"], additionalProperties: false },
    outputSchema: { type: "object", properties: { values: { type: "object" } }, required: ["values"] } },
  { name: "artifacts_connection_check", title: "Check connection", description: "Check authorized gallery access and report the connected workspace and enabled capabilities. Does not execute artifacts or scripts.",
    annotations: readOnly, _meta: appOnly, inputSchema: emptySchema },
];

export async function settingsTool(service: { workspace: string; productUrl?: string; gallery(all: boolean): Promise<GalleryData> }, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  let payload: Record<string, unknown>;
  if (name === "artifacts_settings_read") {
    payload = { schema: emptySchema, values: {}, layout: [{ kind: "group", title: `Workspace: ${service.workspace}`, items: [{
      kind: "tool", tool: "artifacts_connection_check", title: "Check connection",
      description: service.productUrl ? `Connected to ${service.productUrl}. Connection and workspace are managed by the MCP host.` : "Connected to the local filesystem. Workspace is managed by the MCP host.",
    }] }] };
  } else if (name === "artifacts_settings_update") {
    if (!args.set || typeof args.set !== "object" || Array.isArray(args.set) || Object.keys(args.set).length) throw new Error("Connection settings are managed by the MCP host");
    payload = { values: {} };
  } else if (name === "artifacts_connection_check") {
    const gallery = await service.gallery(true);
    payload = { ok: true, workspace: service.workspace, ...(service.productUrl ? { productUrl: service.productUrl } : {}), capabilities: gallery.capabilities ?? {}, visibleEntriesOnFirstPage: gallery.artifacts.length };
  } else throw new Error("Unknown settings tool");
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
