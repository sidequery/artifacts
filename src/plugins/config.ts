import type { PluginUser } from "./types";

export type PluginContext = {
  user: PluginUser;
  secrets: Readonly<Record<string, string>>;
  signal: AbortSignal;
};

export type PluginOperation = {
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  /** Omit for any authenticated deployment user. Check row-level access in the handler. */
  authorize?: (user: PluginUser) => boolean | Promise<boolean>;
  handler: (input: any, context: PluginContext) => unknown | Promise<unknown>;
};

export type CanvasPlugin = {
  /** Also the public browser import, when a browser entry is supplied. */
  name: string;
  description: string;
  /** Installed package specifier or source entry relative to the configuration file. */
  browser?: string;
  /** Optional declaration entry for JavaScript packages without resolvable types. */
  types?: string;
  /** Host environment binding names made available only to this plugin's handlers. */
  secrets?: readonly string[];
  operations?: Record<string, PluginOperation>;
};

/** Configuration is trusted operator code, evaluated only during build and on the server. */
export function definePlugins<const T extends readonly CanvasPlugin[]>(plugins: T): T {
  return plugins;
}
