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
  if (tool.name === "canvas_write") {
    tool.inputSchema.properties = { ...tool.inputSchema.properties,
      server: { type: ["string", "null"], description: "Optional native server TypeScript exporting class CanvasServer extends DurableObject from cloudflare:workers. Use this.ctx.storage.sql for native SQLite and this.ctx.storage.kv for key/value storage. Omit to preserve; null removes server code without deleting its database." },
    };
  }
  if (tool.name === "canvas_read" || tool.name === "canvas_edit") {
    tool.inputSchema.properties = { ...tool.inputSchema.properties,
      part: { type: "string", enum: ["client", "server"], default: "client", description: "Select browser TSX or native server TypeScript." },
    };
  }
}

export const CANVAS_REQUEST_SCHEMA = {
  type: "object", properties: {
    path: { type: "string", minLength: 1, maxLength: 8192 },
    method: { type: "string", default: "GET" },
    headers: { type: "array", maxItems: 100, items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } },
    body: { type: "string", maxLength: 349528, description: "Base64-encoded request body, maximum 256 KiB decoded." },
  }, required: ["path"], additionalProperties: false,
};
CLOUD_MCP_TOOLS.push({
  name: "canvas_request",
  description: "Send an HTTP request to a canvas's native server. Its fetch handler can use native Durable Object SQLite/KV APIs. Select name or version_id. Database contents remain live across source edits and restores. Returns a response envelope with base64 body; canvasFetch provides ordinary Request/Response behavior in the UI.",
  inputSchema: { type: "object", properties: {
    name: { type: "string" }, version_id: { type: "string" }, request: CANVAS_REQUEST_SCHEMA,
  }, required: ["request"], anyOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
});
