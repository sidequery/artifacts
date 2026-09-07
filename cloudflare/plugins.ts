import type { CanvasPlugin } from "../src/plugins/config";
import type { PluginRequest, PluginUser } from "../src/plugins/types";
import installed from "../dist/cloudflare/plugin-server";
import { validatePluginInput, validatePluginOutput } from "../dist/cloudflare/plugin-validators.js";
import catalog from "../dist/cloudflare/plugin-catalog.json";

export const PLUGIN_JSON_LIMIT = 256 * 1024;
export const PLUGIN_GUIDE = `Deployment plugins provide installed browser modules and authenticated server functions. Call plugins_list to discover operation names, schemas, and read-only hints. Call canvas_plugin_call with {plugin, operation, input}, or use pluginCall from sidequery/canvas in a hosted canvas. Calls run as the authenticated deployment user, independently of canvas, version, workspace, or library selectors. Plugins may restrict users and must check row-level access in their handlers. Public standalone canvases cannot call plugins. Provider credentials stay on the server. Canvas backends and scripts do not receive this bridge.`;
export const pluginCatalog = catalog;
export type PluginInvocationContext = { user: PluginUser; env: object };
export class PluginError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 413 | 500 | 504) { super(message); }
}

function jsonValue(value: unknown, output = false): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, part) => {
      if (typeof part === "number" && !Number.isFinite(part) || ["undefined", "function", "symbol", "bigint"].includes(typeof part)) throw new Error();
      return part;
    });
  } catch { throw new PluginError(output ? "Plugin returned invalid JSON" : "Input must be JSON", output ? 500 : 400); }
  if (serialized === undefined) throw new PluginError(output ? "Plugin returned invalid JSON" : "Input must be JSON", output ? 500 : 400);
  if (new TextEncoder().encode(serialized).byteLength > PLUGIN_JSON_LIMIT) throw new PluginError(output ? "Plugin result exceeds 256 KiB" : "Plugin input exceeds 256 KiB", output ? 500 : 413);
  return JSON.parse(serialized);
}

export function createPluginDispatcher(plugins: readonly CanvasPlugin[], validators: {
  input: typeof validatePluginInput; output: typeof validatePluginOutput;
}, timeoutMs = 30_000) {
  return async (request: PluginRequest, context?: PluginInvocationContext): Promise<unknown> => {
    if (!context?.user.subject || !context.user.authority) throw new PluginError("Plugin sign-in required", 401);
    if (!request || typeof request !== "object" || typeof request.plugin !== "string" || typeof request.operation !== "string" || !Object.hasOwn(request, "input") || Object.keys(request).some(key => !["plugin", "operation", "input"].includes(key))) throw new PluginError("Invalid plugin request", 400);
    const plugin = plugins.find(plugin => plugin.name === request.plugin);
    const operation = plugin?.operations && Object.hasOwn(plugin.operations, request.operation) ? plugin.operations[request.operation] : undefined;
    if (!plugin || !operation) throw new PluginError("Plugin operation not found", 404);
    const input = jsonValue(request.input);
    if (!validators.input(request.plugin, request.operation, input)) throw new PluginError("Invalid plugin input", 400);
    // Handlers are trusted deployment code. The signal cancels cooperative I/O;
    // the deadline bounds asynchronous work even if it ignores cancellation.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PluginError("Plugin operation timed out", 504)); }, timeoutMs); });
    try {
      return await Promise.race([timeout, (async () => {
        const user = Object.freeze({ subject: context.user.subject, authority: context.user.authority });
        let authorized: boolean;
        try { authorized = operation.authorize ? await operation.authorize(user) : true; }
        catch { throw new PluginError("Plugin authorization failed", 500); }
        if (!authorized) throw new PluginError("Plugin operation is not allowed", 403);
        if (controller.signal.aborted) throw new PluginError("Plugin operation timed out", 504);
        const secrets: Record<string, string> = Object.create(null);
        for (const name of plugin.secrets ?? []) {
          const value = Object.hasOwn(context.env, name) ? (context.env as Record<string, unknown>)[name] : undefined;
          if (typeof value !== "string") throw new PluginError("Plugin configuration unavailable", 500);
          secrets[name] = value;
        }
        let result: unknown;
        try { result = await operation.handler(input, { user, secrets: Object.freeze(secrets), signal: controller.signal }); }
        catch { throw new PluginError("Plugin operation failed", 500); }
        const output = jsonValue(result, true);
        if (!validators.output(request.plugin, request.operation, output)) throw new PluginError("Plugin returned invalid output", 500);
        return output;
      })()]);
    } finally { clearTimeout(timer!); }
  };
}
export const dispatchPlugin = createPluginDispatcher(installed, { input: validatePluginInput, output: validatePluginOutput });
