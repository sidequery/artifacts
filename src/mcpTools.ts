import { CANVAS_APP_META } from "./mcpAppContract";

export const MCP_TOOLS = [
  {
    name: "canvas_guide",
    description: "Read the Canvas authoring guide: supported SDK exports, hooks, common component props, restrictions, validation behavior, and a working interactive example. Call before creating a canvas if you have not read it in this conversation.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "canvas_read",
    description: "Read working raw TSX by inclusive 1-based line range (default 200 lines). Returns exact source with line endings, total_lines, next_line and a full-file source_hash for guarded edits. Rejects symlinks and names with slashes.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "canvas_edit",
    _meta: CANVAS_APP_META,
    description: "Apply sequential exact-text replacements to a working canvas. Every non-empty old_text must match exactly once; empty new_text deletes. Optional expected_hash guards against changes since canvas_read. Invalid batches write nothing. Atomically replaces source then typechecks once; failed diagnostics leave edits applied. Returns compact summary, hash and diagnostics, not source. Rejects symlinks and names with slashes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        edits: { type: "array", minItems: 1, items: { type: "object", properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } }, required: ["old_text", "new_text"], additionalProperties: false } },
        expected_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["name", "edits"], additionalProperties: false,
    },
  },
  {
    name: "canvas_history",
    description: "List archived artifact versions in this workspace, including deleted canvases. Optionally filter by name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "canvas_version",
    description: "Read an archived version's raw TSX, metadata, and serve events with initial-state snapshots.",
    inputSchema: { type: "object", properties: { version_id: { type: "string" } }, required: ["version_id"], additionalProperties: false },
  },
  {
    name: "canvas_restore",
    _meta: CANVAS_APP_META,
    description: "Replace a working canvas with archived TSX. Saves the current working source first, adds a new revision, and preserves later history and current UI state. Returns typecheck diagnostics after restoration.",
    inputSchema: { type: "object", properties: { version_id: { type: "string" } }, required: ["version_id"], additionalProperties: false },
  },
  {
    name: "canvas_list",
    description: "List .canvas.tsx files in the canvases directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "canvas_write",
    _meta: CANVAS_APP_META,
    description:
      "Create or replace a canvas and display it inline in chat after typechecking. Before creating a canvas, call canvas_guide if you have not read it in this conversation. Import only from herdr/canvas; use useCanvasState(key, defaultValue), not useState. Pass kebab-case name without slashes. Returns Canvas TypeScript check diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Canvas name, e.g. billing-review or billing-review.canvas.tsx" },
        contents: { type: "string", description: "Full .canvas.tsx source" },
        open: { type: "boolean", description: "Legacy flag; successful writes now always show the canvas inline." },
        target: { type: "string", enum: ["inline", "herdr"], default: "inline", description: "Use herdr only to explicitly open a terminal pane as well." },
      },
      required: ["name", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_typecheck",
    description: "Typecheck and sandbox-scan a canvas file.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_compile",
    description: "Sandbox-scan and bundle a canvas file with Bun.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_open",
    _meta: CANVAS_APP_META,
    description: "Show the interactive canvas inline in chat. Supply name for a working canvas, or version_id for an archived canvas. Optional event_id selects archived initial state. Use target: herdr only to explicitly open a terminal pane instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version_id: { type: "string" },
        event_id: { type: "string" },
        target: { type: "string", enum: ["inline", "herdr"], default: "inline" },
        placement: { type: "string", enum: ["split", "tab", "zoomed", "overlay"] },
      },
      oneOf: [{ required: ["name"] }, { required: ["version_id"] }],
      additionalProperties: false,
    },
  },
] as const;
