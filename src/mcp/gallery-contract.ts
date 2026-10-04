import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Operations used by the existing artifact/script gallery panels, not a proxy
 * for arbitrary MCP tools. The model-facing tools keep their existing visibility. */
export const GALLERY_TOOL_NAMES = [
  "artifact_write", "artifact_restore", "artifact_remix", "artifact_import", "artifact_export", "artifact_link",
  "script_write", "script_restore", "script_remix", "script_import", "script_export", "script_run", "script_logs",
  "script_schedule", "script_runs", "artifact_schedule", "artifact_runs", "artifact_secrets", "script_secrets",
] as const;

export function galleryToolDefinition(tools: readonly Tool[]): Tool {
  const operations = GALLERY_TOOL_NAMES.map(name => {
    const tool = tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Missing gallery operation: ${name}`);
    // Reuse the authoritative schema so the proxy cannot skip field validation.
    // Workspace belongs to the outer envelope and cannot be overridden inside it.
    const schema = structuredClone(tool.inputSchema);
    delete schema.properties?.workspace;
    return { properties: { tool: { const: name }, arguments: schema }, required: ["tool", "arguments"] };
  });
  return {
    name: "artifacts_tool", title: "Artifact workspace action",
    description: "Run an existing artifact or script gallery action in the selected authorized workspace. Validates the original tool schema and preserves save diagnostics and revision conflicts.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object", properties: {
        workspace: { type: "string", minLength: 1 },
        tool: { type: "string", enum: [...GALLERY_TOOL_NAMES] },
        arguments: { type: "object" },
      }, required: ["workspace", "tool", "arguments"], additionalProperties: false, oneOf: operations,
    },
  };
}
