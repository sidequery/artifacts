import type { ArtifactPlugin } from "./config";
import { createPluginDispatcher, PluginError, type PluginValidators } from "./dispatch";
import type { PluginUser } from "./types";

/**
 * The default export of a runtime plugin's bundled module (see
 * scripts/bundle-plugin.ts). It runs in the plugin's own isolate, whose `env`
 * holds only the plugin's declared secrets, and applies the same dispatcher as
 * build-time plugins: input/output schemas, `authorize`, timeout, and fixed,
 * provider-free error messages. The host reads `{ result }` or `{ error, status }`.
 */
export function runtimePluginHandler(plugin: ArtifactPlugin, validators: PluginValidators) {
  const dispatch = createPluginDispatcher([plugin], validators);
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
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
