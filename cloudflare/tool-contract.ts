import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS } from "../src/mcp/tools";

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

const slugProperties = {
  slug: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$", description: "Chosen root URL slug, unique across this deployment." },
  access: { type: "string", enum: ["private", "public"], description: "Private uses library permissions; public allows external HTTP callers. Default private." },
};
const canvasWrite = CLOUD_MCP_TOOLS.find(tool => tool.name === "canvas_write")!;
Object.assign(canvasWrite.inputSchema.properties!, slugProperties);
function addScriptTool(name: string, description: string, properties: Record<string, object>, required: string[] = []) {
  CLOUD_MCP_TOOLS.push({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
}
const nameProperty = { name: { type: "string", minLength: 1, description: "Script name in this workspace." } };
const pageProperty = { offset: { type: "integer", minimum: 0, default: 0 } };
addScriptTool("artifact_link", "Give a canvas or script a chosen root URL. Canvas links require valid source and work independently of the gallery. Defaults to private access. Renaming a slug changes its URL.", {
  kind: { type: "string", enum: ["canvas", "script"] }, name: { type: "string", minLength: 1 }, ...slugProperties,
}, ["kind", "name", "slug"]);
addScriptTool("script_guide", "Read the hosted script and root-URL authoring guide before creating a script. Covers runtime, access, storage, secrets, validation, HTTP requests, and bundling third-party dependencies.", {});
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: true };
addScriptTool("script_write", "Call script_guide first. Create or replace arbitrary Workers-compatible TypeScript exporting default { fetch(request, env, ctx) }. Saved drafts and history are retained even when validation fails; only valid updates replace the running code. Scripts have outbound fetch, env.secrets, and env.sql for persistent SQLite. Slug defaults to the name; URLs use /<slug>. One module only: Workers/Node builtins or prebundled third-party code (see script_guide). No package installation at request time. This loads the module for validation but does not execute the handler.", {
  ...nameProperty, contents: { type: "string", maxLength: 262144 }, ...slugProperties,
}, ["name", "contents"]);
addScriptTool("script_read", "Read script source with bounded line ranges, optionally from a historical version. Does not execute the script.", {
  ...nameProperty, version_id: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
}, ["name"]);
addScriptTool("script_edit", "Apply ordered, uniquely matching text replacements atomically, validate, and update the same URL on success. Invalid drafts retain the last working handler.", {
  ...nameProperty, edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } }, required: ["old_text", "new_text"], additionalProperties: false } }, expected_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
}, ["name", "edits"]);
addScriptTool("script_list", "List saved scripts and their URLs without running them. Paginated, 100 per response.", pageProperty);
addScriptTool("script_run", "Execute a script's last validated handler. request.path is passed unchanged at the deployment origin; include the slug to reproduce a direct URL request. Returns HTTP response headers, status, and base64 body (maximum 256 KiB); use its URL for streaming or larger responses. May perform arbitrary script-defined writes or outbound requests.", { ...nameProperty, request: CANVAS_REQUEST_SCHEMA }, ["name", "request"]);
addScriptTool("script_history", "List script source history, 100 entries per page.", { ...nameProperty, ...pageProperty });
addScriptTool("script_version", "Read an immutable script source revision. Never returns secrets.", { version_id: { type: "string" } }, ["version_id"]);
addScriptTool("script_restore", "Restore a script revision as a new draft and activate it if validation succeeds. Persistent storage remains live.", { ...nameProperty, version_id: { type: "string" } }, ["name", "version_id"]);
addScriptTool("script_logs", "Read bounded recent execution logs and errors without executing the script.", { ...nameProperty, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["name"]);
addScriptTool("script_secrets", "Set or delete per-script secrets (null deletes). Omit secrets to list names. Values are never returned or added to source history.", { ...nameProperty, secrets: { type: "object", maxProperties: 32, additionalProperties: { type: ["string", "null"], maxLength: 4096 } } }, ["name"]);
