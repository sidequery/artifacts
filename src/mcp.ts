import { CanvasService, type CanvasEdit, type ReadOptions } from "./service";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcpProtocol";

const PROTOCOL_VERSION = "2024-11-05";

export const MCP_TOOLS = [
  {
    name: "canvas_read",
    description: "Read working raw TSX by inclusive 1-based line range (default 200 lines). Returns exact source with line endings, total_lines, next_line and a full-file source_hash for guarded edits. Rejects symlinks and names with slashes.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "canvas_edit",
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
    description:
      "Write a canvas file, then typecheck it. Pass kebab-case name without slashes. Returns Canvas TypeScript check diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Canvas name, e.g. billing-review or billing-review.canvas.tsx" },
        contents: { type: "string", description: "Full .canvas.tsx source" },
        open: { type: "boolean", description: "Compile and open in Terminal Browser after a successful typecheck" },
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
    description: "Open a managed Canvas pane. Supply name for a working canvas, or version_id for saved raw TSX rebuilt with the installed SDK and isolated initial state. Optional event_id selects an archived version's initial state.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version_id: { type: "string" },
        event_id: { type: "string" },
        placement: { type: "string", enum: ["split", "tab", "zoomed", "overlay"] },
      },
      oneOf: [{ required: ["name"] }, { required: ["version_id"] }],
      additionalProperties: false,
    },
  },
] as const;

export async function handleMcpRequest(
  request: JsonRpcRequest,
  service: CanvasService,
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }

  try {
    if (request.method === "initialize") {
      return ok(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "canvas", version: "0.1.0" },
      });
    }
    if (request.method === "ping") {
      return ok(request.id, {});
    }
    if (request.method === "tools/list") {
      return ok(request.id, { tools: MCP_TOOLS });
    }
    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const result = await callTool(service, params.name ?? "", params.arguments ?? {});
      return ok(request.id, result);
    }
    return error(request.id, -32601, `unknown method: ${request.method}`);
  } catch (err) {
    return error(request.id, -32000, err instanceof Error ? err.message : String(err));
  }
}

async function callTool(
  service: CanvasService,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (name === "canvas_read" || name === "canvas_edit") {
    if (typeof args.name !== "string") throw new Error("canvas name must be a string");
    if (name === "canvas_read") {
      return text(JSON.stringify(service.readRange(args.name, { start_line: args.start_line, end_line: args.end_line } as ReadOptions)));
    }
    const result = service.edit(args.name, args.edits as CanvasEdit[], args.expected_hash as string | undefined);
    return text(JSON.stringify(result), !result.ok);
  }
  if (name === "canvas_history") return text(JSON.stringify({ versions: service.history(args.name === undefined ? undefined : String(args.name)) }, null, 2));
  if (name === "canvas_version") return text(JSON.stringify(service.version(String(args.version_id)), null, 2));
  if (name === "canvas_restore") {
    const result = service.restore(String(args.version_id));
    return text(JSON.stringify(result, null, 2), !result.ok);
  }
  if (name === "canvas_list") {
    return text(JSON.stringify({ canvases: service.list() }, null, 2));
  }
  if (name === "canvas_write") {
    const written = service.write(String(args.name), String(args.contents ?? ""));
    let opened: unknown;
    if (args.open && written.ok) {
      opened = await service.open(written.path);
    }
    const payload = { ...written, opened };
    return text(`${written.check}\n\n${JSON.stringify(payload, null, 2)}`, !written.ok);
  }
  if (name === "canvas_typecheck") {
    const result = service.typecheck(String(args.name));
    return text(`${result.check}\n\n${JSON.stringify(result, null, 2)}`, result.diagnostics.length > 0);
  }
  if (name === "canvas_compile") {
    const result = await service.compile(String(args.name));
    return text(
      `${result.check}\n\n${JSON.stringify({ ok: result.ok, path: result.path, bytes: result.js?.length ?? 0 }, null, 2)}`,
      !result.ok,
    );
  }
  if (name === "canvas_open") {
    if (Boolean(args.name) === Boolean(args.version_id)) throw new Error("provide name or version_id, but not both");
    const result = await service.open(args.name === undefined ? "" : String(args.name), {
      versionId: args.version_id === undefined ? undefined : String(args.version_id),
      eventId: args.event_id === undefined ? undefined : String(args.event_id),
      placement: args.placement as "split" | "tab" | "zoomed" | "overlay" | undefined,
    });
    return text(`${result.check}\n\n${JSON.stringify(result, null, 2)}`, !result.ok);
  }
  throw new Error(`unknown tool: ${name}`);
}

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], isError };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
