/** Host UI support is negotiated independently from server authentication. */
export const ARTIFACTS_DISPLAY_MODES = ["inline", "fullscreen"] as const;

const sharedTools = new Set([
  "artifact_open", "artifact_list", "artifact_read", "artifact_history", "artifact_version", "artifact_export",
  "artifact_request", "artifact_files", "artifact_plugin_call", "plugins_list", "plugin_guide",
]);

/** UI visibility does not grant access; the server still authorizes every call. */
export function applyToolVisibility<T extends { name: string; _meta?: Record<string, unknown> }>(tools: readonly T[]): void {
  for (const tool of tools) {
    const ui = tool._meta?.ui as Record<string, unknown> | undefined;
    if (ui?.visibility) continue;
    tool._meta = { ...tool._meta, ui: { ...ui, visibility: sharedTools.has(tool.name) ? ["model", "app"] : ["model"] } };
  }
}

export function clientSupportsApps(capabilities: unknown): boolean {
  const value = capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
  const mimeTypes = value?.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes("text/html;profile=mcp-app");
}

/** Text clients keep every model tool and its ordinary annotations/schema. */
export function toolsForClient<T extends { name: string; _meta?: Record<string, unknown> }>(tools: readonly T[], apps: boolean): readonly T[] {
  if (apps) return tools;
  return tools.filter(tool => {
    const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
    return !visibility || visibility.includes("model");
  }).map(tool => {
    const { _meta, ...rest } = tool;
    return rest as T;
  });
}
