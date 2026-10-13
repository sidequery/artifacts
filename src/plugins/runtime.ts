import type { PluginInfo, PluginOperationInfo } from "./types";

/**
 * A plugin published at runtime: one self-contained object per plugin under
 * `plugins/` in the deployment's optional `PLUGINS` R2 bucket. `module` is the
 * bundled server entry (scripts/bundle-plugin.ts); the host runs it in its own
 * isolate and reads only the metadata here. Replacing the object publishes a
 * new version; nothing is compiled by the host.
 */
export type RuntimePluginRecord = {
  format: 1;
  name: string;
  description: string;
  secrets: string[];
  operations: PluginOperationInfo[];
  module: string;
  /** SHA-256 of `module`; part of the isolate cache key. */
  hash: string;
};

export const RUNTIME_PLUGIN_PREFIX = "plugins/";
export const RUNTIME_PLUGIN_MAX_BYTES = 16 * 1024 * 1024;
export const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Published plugins read only `PLUGIN_*` deployment variables, so write
 * access to the bucket never reaches the host's own credentials (auth secret,
 * provider and fleet tokens). Build-time plugins are unrestricted. */
export const RUNTIME_PLUGIN_SECRET = /^PLUGIN_[A-Z0-9_]{1,64}$/;
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function runtimePluginKey(name: string): string {
  if (!PLUGIN_NAME.test(name)) throw new Error("Invalid plugin name");
  return `${RUNTIME_PLUGIN_PREFIX}${name}.json`;
}

const isSchema = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);

/** Validates a stored record. A record that fails is a configuration error, never an empty plugin. */
export function parseRuntimePlugin(value: unknown, expectedName?: string): RuntimePluginRecord {
  const record = value as Partial<RuntimePluginRecord> | null;
  if (!record || typeof record !== "object" || record.format !== 1) throw new Error("Unsupported plugin record format");
  if (typeof record.name !== "string" || !PLUGIN_NAME.test(record.name) || (expectedName !== undefined && record.name !== expectedName)) throw new Error("Plugin record name does not match its key");
  if (typeof record.description !== "string" || record.description.length > 8192) throw new Error("Invalid plugin description");
  if (!Array.isArray(record.secrets) || record.secrets.length > 32 || record.secrets.some(name => typeof name !== "string" || !RUNTIME_PLUGIN_SECRET.test(name))) throw new Error("Published plugin secrets must be named PLUGIN_*");
  if (!Array.isArray(record.operations) || !record.operations.length || record.operations.length > 128) throw new Error("Invalid plugin operations");
  const names = new Set<string>();
  for (const operation of record.operations) {
    if (!operation || typeof operation.name !== "string" || !OPERATION_NAME.test(operation.name) || names.has(operation.name)
      || typeof operation.description !== "string" || operation.description.length > 8192 || typeof operation.readOnly !== "boolean"
      || !isSchema(operation.inputSchema) || (operation.outputSchema !== undefined && !isSchema(operation.outputSchema))) throw new Error("Invalid plugin operation");
    names.add(operation.name);
  }
  if (typeof record.module !== "string" || !record.module) throw new Error("Plugin record has no module");
  if (typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash)) throw new Error("Invalid plugin module hash");
  return record as RuntimePluginRecord;
}

export function runtimePluginInfo(record: RuntimePluginRecord): PluginInfo {
  return { name: record.name, description: record.description, browser: false, operations: record.operations };
}
