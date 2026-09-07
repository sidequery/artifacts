import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS } from "../src/mcpTools";

// Share the local tool contract. A hosted service cannot open a terminal pane.
export const CLOUD_MCP_TOOLS: Tool[] = JSON.parse(JSON.stringify(MCP_TOOLS));
for (const tool of CLOUD_MCP_TOOLS) {
  tool.description = tool.description?.replaceAll(" Rejects symlinks and names with slashes.", " Rejects names with slashes.")
    .replace("Sandbox-scan and bundle a canvas file with Bun.", "Typecheck, sandbox-scan and compile a canvas for the browser.")
    .replace("List .canvas.tsx files in the canvases directory.", "List working canvases in this workspace.")
    .replace(" Use target: herdr only to explicitly open a terminal pane instead.", "");
  if (tool.inputSchema.properties?.target) {
    tool.inputSchema.properties.target = { type: "string", enum: ["inline"], default: "inline", description: "Hosted canvases open inline in the MCP App viewer." };
    delete tool.inputSchema.properties.placement;
  }
  if (tool.name === "canvas_list" || tool.name === "canvas_history" || tool.name === "canvas_version") {
    const field = tool.name === "canvas_version" ? "events_offset" : "offset";
    tool.inputSchema.properties = { ...tool.inputSchema.properties, [field]: { type: "integer", minimum: 0, default: 0 } };
    tool.description += tool.name === "canvas_version"
      ? " Serve events are paginated, 20 per response; pass next_events_offset as events_offset for older events."
      : " Results are paginated, 100 per response; pass next_offset as offset for the next page.";
  }
}
