import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SDK_ENTRY = join(PLUGIN_ROOT, "src/sdk/index.ts");
export const WRAPPER_ENTRY = join(PLUGIN_ROOT, "src/runtime/wrapper.tsx");
export const CLI_ENTRY = join(PLUGIN_ROOT, "src/cli.ts");
