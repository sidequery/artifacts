import type { PluginInfo, PluginRequest } from "../src/plugins/types";
import installed from "../dist/cloudflare/plugin-server";
import { validatePluginInput, validatePluginOutput } from "../dist/cloudflare/plugin-validators.js";
import catalog from "../dist/cloudflare/plugin-catalog.json";
import { assertPluginRequest, createPluginDispatcher, pluginJson, PluginError, type PluginInvocationContext } from "../src/plugins/dispatch";
import { callRuntimePlugin, runtimePlugin, runtimePluginCatalog, type RuntimePluginEnvironment } from "./runtime-plugins";

export { createPluginDispatcher, PluginError, PLUGIN_JSON_LIMIT, type PluginInvocationContext } from "../src/plugins/dispatch";
export const PLUGIN_GUIDE = `Deployment plugins provide installed browser modules and authenticated server functions. Call plugins_list to discover operation names, schemas, and read-only hints. Call artifact_plugin_call with {plugin, operation, input}, or use pluginCall from sidequery/artifacts in a hosted artifact. Calls run as the authenticated deployment user, independently of artifact, version, workspace, or library selectors. Plugins may restrict users and must check row-level access in their handlers. Public standalone artifacts cannot call plugins. Provider credentials stay on the server. Artifact backends and scripts do not receive this bridge.`;
export const pluginCatalog = catalog;

const installedNames = new Set<string>(installed.map(plugin => plugin.name));
const dispatchInstalled = createPluginDispatcher(installed, { input: validatePluginInput, output: validatePluginOutput });

/** Build-time plugins take precedence; a published plugin cannot shadow one. */
export async function dispatchPlugin(request: PluginRequest, context?: PluginInvocationContext): Promise<unknown> {
  assertPluginRequest(request, context);
  if (installedNames.has(request.plugin)) return dispatchInstalled(request, context);
  const record = await runtimePlugin(context.env as RuntimePluginEnvironment, request.plugin);
  if (!record?.operations.some(operation => operation.name === request.operation)) throw new PluginError("Plugin operation not found", 404);
  return callRuntimePlugin(record, request.operation, pluginJson(request.input), context.user, context);
}

export async function pluginCatalogFor(env: object): Promise<PluginInfo[]> {
  const published = await runtimePluginCatalog(env as RuntimePluginEnvironment);
  return [...catalog, ...published.filter(plugin => !installedNames.has(plugin.name))];
}
