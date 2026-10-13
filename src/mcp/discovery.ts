import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ARTIFACTS_APP_META } from "./app-contract";

export const DIRECT_TOOL_NAMES = [
  "artifact_guide", "artifact_list", "artifact_read", "artifact_write", "artifact_edit", "artifact_open",
] as const;
export const DISCOVERY_TOOL_NAMES = ["artifacts_discover", "artifacts_query", "artifacts_execute"] as const;

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const dispatchSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    operation: { type: "string", minLength: 1, maxLength: 128, description: "Operation name from artifacts_discover." },
    arguments: { type: "object", description: "Arguments matching that operation's discovered inputSchema. Validated before execution." },
  },
  required: ["operation", "arguments"], additionalProperties: false,
};

export const DISCOVERY_TOOLS: Tool[] = [
  {
    name: "artifacts_discover",
    description: "Discover every operation available through this connection. Search with query for concise matches; inspect with operation for its exact schema, dispatch tool and relevant guide. Omit both to browse the paginated catalog. Discovery never runs application code or unlocks tools. Use artifacts_query for reads and artifacts_execute for actions.",
    annotations: readOnly, _meta: { ui: { visibility: ["model"] } },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 256 },
        operation: { type: "string", minLength: 1, maxLength: 128 },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 8 },
        include_docs: { type: "boolean", default: true, description: "Include the relevant guide when inspecting an operation. False avoids rereading a guide already loaded." },
      },
      not: { required: ["query", "operation"] }, additionalProperties: false,
    },
  },
  {
    name: "artifacts_query",
    description: "Invoke a discovered read-only operation with its original validation and authorization. Rejects changes and application execution. Mixed operations permit only schedule get, secret-name listing without a secrets field, and file list/download. Use artifacts_execute for all other cases.",
    annotations: readOnly, _meta: { ui: { visibility: ["model"] } }, inputSchema: dispatchSchema,
  },
  {
    name: "artifacts_execute",
    description: "Invoke any discovered operation with its original validation and authorization, including writes, restores, scripts, backend requests, plugins and native app deployment. May modify storage or call external services. Preserves inline preview results; preview:false suppresses delivery where supported. Never automatically retry an uncertain execution.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ...ARTIFACTS_APP_META, ui: { ...ARTIFACTS_APP_META.ui, visibility: ["model"] } },
    inputSchema: dispatchSchema,
  },
];

export function isDiscoveryTool(name: string): boolean {
  return DISCOVERY_TOOL_NAMES.some(candidate => candidate === name);
}

/** Keep the complete operation registry separate from the advertised model surface. */
export function operationCatalog(tools: readonly Tool[]): Tool[] {
  return tools.filter(tool => {
    const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    return !isDiscoveryTool(tool.name) && (!visibility || visibility.includes("model"));
  });
}

/** Apps retain the operations they already use; text clients see only nine tools. */
export function compactToolSurface(tools: readonly Tool[]): Tool[] {
  const direct = DIRECT_TOOL_NAMES.map(name => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Missing direct MCP tool: ${name}`);
    return tool;
  });
  const appTools = tools.filter(tool => {
    const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    return !DIRECT_TOOL_NAMES.some(name => name === tool.name) && visibility?.includes("app");
  }).map(tool => ({
    ...tool, _meta: { ...tool._meta, ui: { ...(tool._meta?.ui as Record<string, unknown>), visibility: ["app"] } },
  }));
  return [...direct, ...DISCOVERY_TOOLS, ...appTools];
}

// An explicit allowlist is intentional: newly added operations default to actions.
// An HTTP GET to authored code is still execution, irrespective of its method.
const READ_OPERATIONS = new Set([
  "artifact_guide", "artifact_list", "artifact_read", "artifact_history", "artifact_version", "artifact_export", "artifact_typecheck", "artifact_runs",
  "script_guide", "script_list", "script_read", "script_history", "script_version", "script_export", "script_logs", "script_runs",
  "app_guide", "app_list", "app_read", "app_history", "plugins_list", "plugin_guide",
]);
const MIXED_OPERATIONS: Record<string, string> = {
  artifact_schedule: "action omitted or get, with no schedule configuration fields",
  script_schedule: "action omitted or get, with no schedule configuration fields",
  artifact_secrets: "secrets field omitted; returns names only",
  script_secrets: "secrets field omitted; returns names only",
  app_secrets: "secrets field omitted; returns names only",
  artifact_files: "request.operation is list or download",
};

export function isReadOnlyOperation(operation: string, args: Record<string, unknown>): boolean {
  if (READ_OPERATIONS.has(operation)) return true;
  if (operation === "artifact_schedule" || operation === "script_schedule") {
    return (args.action === undefined || args.action === "get") &&
      !["interval_seconds", "cron", "timezone", "request"].some(field => Object.hasOwn(args, field));
  }
  if (["artifact_secrets", "script_secrets", "app_secrets"].includes(operation)) return !Object.hasOwn(args, "secrets");
  if (operation === "artifact_files") {
    const request = args.request as { operation?: unknown } | undefined;
    return request?.operation === "list" || request?.operation === "download";
  }
  return false;
}

function operationSummary(tool: Tool) {
  const mixed = Object.hasOwn(MIXED_OPERATIONS, tool.name);
  return {
    operation: tool.name, description: tool.description,
    dispatch: READ_OPERATIONS.has(tool.name) ? "artifacts_query" : "artifacts_execute",
    ...(mixed ? { read_only_when: MIXED_OPERATIONS[tool.name] } : {}),
  };
}

function findOperation(catalog: readonly Tool[], name: unknown): Tool {
  const tool = typeof name === "string" ? catalog.find(tool => tool.name === name) : undefined;
  if (!tool) throw new Error("Unknown operation. Use artifacts_discover to find an available operation.");
  return tool;
}

function guideOperation(operation: string): string {
  if (operation.startsWith("app_")) return "app_guide";
  if (operation.startsWith("script_")) return "script_guide";
  if (["plugins_list", "plugin_guide", "artifact_plugin_call"].includes(operation)) return "plugin_guide";
  return "artifact_guide";
}

function searchCatalog(catalog: readonly Tool[], query: string): Tool[] {
  const ignoredWords = new Set(["the", "and", "for", "with", "how", "to", "of", "an"]);
  const words = query.toLowerCase().split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !ignoredWords.has(word));
  const matches = catalog.map(tool => {
    const name = tool.name.toLowerCase();
    const description = tool.description?.toLowerCase() ?? "";
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 3;
      if (description.includes(word)) score += 1;
    }
    return { tool, score };
  });
  return matches
    .filter(match => !words.length || match.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(match => match.tool);
}

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/** The callback must validate the original schema and enter the original admission path. */
export async function callDiscoveryTool(
  tools: readonly Tool[], name: string, args: Record<string, unknown>,
  callOperation: (operation: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const catalog = operationCatalog(tools);
  if (name === "artifacts_discover") {
    if (args.operation !== undefined) {
      const tool = findOperation(catalog, args.operation);
      const guide = guideOperation(tool.name);
      let guideArgs: Record<string, unknown> = {};
      if (tool.name === "artifact_files") guideArgs = { topic: "files" };
      else if (["artifact_request", "artifact_schedule", "artifact_runs", "artifact_secrets"].includes(tool.name)) guideArgs = { topic: "backend" };
      const documentation = args.include_docs === false ? undefined : await callOperation(guide, guideArgs);
      return jsonResult({
        ...operationSummary(tool), inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations ?? {},
        ...(documentation ? { documentation: { operation: guide, content: documentation.content } } : {}),
      });
    }
    const matches = searchCatalog(catalog, typeof args.query === "string" ? args.query : "");
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const limit = typeof args.limit === "number" ? args.limit : 8;
    return jsonResult({ operations: matches.slice(offset, offset + limit).map(operationSummary), total: matches.length,
      next_offset: offset + limit < matches.length ? offset + limit : null });
  }
  if (name !== "artifacts_query" && name !== "artifacts_execute") throw new Error("Unknown discovery tool");
  const tool = findOperation(catalog, args.operation);
  const input = args.arguments;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Operation arguments must be an object");
  if (name === "artifacts_query" && !isReadOnlyOperation(tool.name, input as Record<string, unknown>)) {
    throw new Error(`${tool.name} may change state or execute code with these arguments. Use artifacts_execute.`);
  }
  // Return the original envelope, including preview _meta, diagnostics and isError.
  return callOperation(tool.name, input as Record<string, unknown>);
}
