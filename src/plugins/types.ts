/** Public transport data. Provider credentials are never part of this contract. */
export type PluginRequest = { plugin: string; operation: string; input: unknown };
export type PluginUser = { subject: string; authority: string };
export type PluginOperationInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly: boolean;
};
export type PluginInfo = { name: string; description: string; browser: boolean; operations: PluginOperationInfo[] };
export type BrowserPlugins = {
  modules: Record<string, string>;
  files: Record<string, string>;
  paths: Record<string, string[]>;
};
