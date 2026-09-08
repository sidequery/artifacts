import { join } from "node:path";
import { PLUGIN_ROOT } from "../paths";

export async function authBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(PLUGIN_ROOT, "src/auth/client.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error(`auth build failed: ${result.logs.join("\n")}`);
  return (await Promise.all(result.outputs.map(output => output.text()))).join("\n");
}

export function authPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artifacts authentication</title><style>html,body{margin:0;background:#141414;color:#e5e5e5;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/auth.js"></script></body></html>`;
}
