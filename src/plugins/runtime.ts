import type { PluginInfo, PluginOperationInfo } from "./types";

/**
 * A plugin published at runtime is its TypeScript source, stored as
 * `plugins/<name>.ts` in the deployment's optional `PLUGINS` R2 bucket. The host
 * compiles it on first use and asks the plugin, inside its own isolate, to
 * describe itself; this is that description. The host never evaluates plugin
 * code itself.
 */
export type RuntimePluginDescription = {
  name: string;
  description: string;
  secrets: string[];
  operations: PluginOperationInfo[];
};

export const RUNTIME_PLUGIN_PREFIX = "plugins/";
export const RUNTIME_PLUGIN_EXTENSION = ".ts";
export const RUNTIME_PLUGIN_MAX_BYTES = 1024 * 1024;
export const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Published plugins read only `PLUGIN_*` deployment variables, so write
 * access to the bucket never reaches the host's own credentials (auth secret,
 * provider and fleet tokens). Build-time plugins are unrestricted. */
export const RUNTIME_PLUGIN_SECRET = /^PLUGIN_[A-Z0-9_]{1,64}$/;
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function runtimePluginKey(name: string): string {
  if (!PLUGIN_NAME.test(name)) throw new Error("Invalid plugin name");
  return `${RUNTIME_PLUGIN_PREFIX}${name}${RUNTIME_PLUGIN_EXTENSION}`;
}

const isSchema = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);

/** Checks what a plugin reported about itself. A plugin that fails is a
 * configuration error, never an empty plugin. */
export function parseRuntimePluginDescription(value: unknown, expectedName: string): RuntimePluginDescription {
  const plugin = value as Partial<RuntimePluginDescription> | null;
  if (!plugin || typeof plugin !== "object") throw new Error("Plugin module must default-export definePlugin(...)");
  if (plugin.name !== expectedName) throw new Error(`Plugin name ${JSON.stringify(plugin.name)} does not match its object key ${expectedName}`);
  if (typeof plugin.description !== "string" || plugin.description.length > 8192) throw new Error("Invalid plugin description");
  if (!Array.isArray(plugin.secrets) || plugin.secrets.length > 32 || plugin.secrets.some(name => typeof name !== "string" || !RUNTIME_PLUGIN_SECRET.test(name))) throw new Error("Published plugin secrets must be named PLUGIN_*");
  if (!Array.isArray(plugin.operations) || !plugin.operations.length || plugin.operations.length > 128) throw new Error("A published plugin needs between 1 and 128 server operations");
  const names = new Set<string>();
  for (const operation of plugin.operations) {
    if (!operation || typeof operation.name !== "string" || !OPERATION_NAME.test(operation.name) || names.has(operation.name)
      || typeof operation.description !== "string" || operation.description.length > 8192 || typeof operation.readOnly !== "boolean"
      || !isSchema(operation.inputSchema) || (operation.outputSchema !== undefined && !isSchema(operation.outputSchema))) throw new Error(`Invalid plugin operation ${JSON.stringify(operation?.name)}`);
    names.add(operation.name);
  }
  return plugin as RuntimePluginDescription;
}

export function runtimePluginInfo(plugin: RuntimePluginDescription): PluginInfo {
  return { name: plugin.name, description: plugin.description, browser: false, operations: plugin.operations };
}
