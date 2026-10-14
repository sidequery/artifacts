import type { ArtifactPlugin } from "./config";
import { createPluginDispatcher, PluginError } from "./dispatch";
import type { PluginUser } from "./types";

/**
 * Wraps a published plugin's default export inside its own isolate (the host
 * compiles this module together with the plugin source; see
 * cloudflare/runtime-plugins.ts). The isolate's `env` holds only the plugin's
 * declared secrets.
 *
 * - POST /describe returns the plugin's metadata, without handlers.
 * - POST /call runs one operation through the same dispatcher as build-time
 *   plugins: `authorize`, secrets, timeout and fixed, provider-free errors.
 *   The host validates input and output against the described schemas.
 */
export function runtimePluginHandler(plugin: ArtifactPlugin) {
  const dispatch = createPluginDispatcher([plugin], { input: () => true, output: () => true });
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      if (new URL(request.url).pathname === "/describe") return Response.json(describe(plugin));
      let call: { operation?: unknown; input?: unknown; user?: PluginUser };
      try { call = await request.json(); }
      catch { return Response.json({ error: "Invalid plugin request", status: 400 }); }
      const user = call?.user && typeof call.user.subject === "string" && typeof call.user.authority === "string"
        ? { subject: call.user.subject, authority: call.user.authority } : undefined;
      try {
        const result = await dispatch({ plugin: plugin.name, operation: call.operation as string, input: call.input }, user && { user, env });
        return Response.json({ result });
      } catch (error) {
        return Response.json(error instanceof PluginError ? { error: error.message, status: error.status } : { error: "Plugin operation failed", status: 500 });
      }
    },
  };
}

function describe(plugin: ArtifactPlugin) {
  if (!plugin || typeof plugin !== "object") return null;
  return {
    name: plugin.name,
    description: plugin.description,
    secrets: plugin.secrets ? [...plugin.secrets] : [],
    // Browser modules need a deployment build; a published plugin that names one is rejected.
    operations: plugin.browser || plugin.types ? [] : Object.entries(plugin.operations ?? {}).map(([name, operation]) => ({
      name,
      description: operation?.description,
      inputSchema: operation?.inputSchema,
      ...(operation?.outputSchema ? { outputSchema: operation.outputSchema } : {}),
      readOnly: operation?.readOnly === true,
    })),
  };
}
