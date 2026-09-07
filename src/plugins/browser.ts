import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "../paths";
import type { BrowserPlugins } from "./types";

/** Read build output only; local compile/check never evaluates operator configuration. */
export function loadBrowserPlugins(): BrowserPlugins {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "dist/cloudflare/plugin-browser.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { modules: {}, files: {}, paths: {} };
    throw error;
  }
}
