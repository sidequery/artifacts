import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canvasIdFromFile, assertRegularCanvas, ensureCanvasFileName } from "./canvasFile";
import { compileCanvas } from "./compile";
import { formatCanvasCheck } from "./diagnostics";
import { CanvasHistory, historyPath, runtimeIdentity } from "./history";
import { PLUGIN_ROOT } from "./paths";
import type { CanvasService } from "./service";

export const CANVAS_APP_URI = "ui://canvas/viewer.html";
export const CANVAS_APP_MIME = "text/html;profile=mcp-app";
export const CANVAS_APP_META = { ui: { resourceUri: CANVAS_APP_URI } };
export const CANVAS_RESOURCE = {
  uri: CANVAS_APP_URI, name: "Canvas", mimeType: CANVAS_APP_MIME,
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
};

export type CanvasAppPayload = {
  name: string; versionId: string; eventId: string; sourceHash: string;
  js: string; state: Record<string, unknown>;
};

let shell: Promise<string> | undefined;
export function canvasAppHtml(): Promise<string> {
  return shell ??= buildShell().catch(error => { shell = undefined; throw error; });
}

async function buildShell(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(PLUGIN_ROOT, "src/runtime/mcp-app.ts")],
    target: "browser", format: "esm", minify: true,
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas</title>
<style>
html,body{margin:0;font-family:system-ui,sans-serif;overflow:hidden}
body{background:var(--canvas-background,#181818);color:var(--canvas-foreground,#f0f0f0)}
#canvas-shell{display:flex;flex-direction:column;max-height:min(var(--canvas-inline-limit,600px),100vh);max-height:min(var(--canvas-inline-limit,600px),100dvh);height:var(--canvas-fixed-height,auto);min-width:0}
#canvas-toolbar{display:flex;justify-content:flex-end;flex:none;padding:4px 12px}
#canvas-toolbar[hidden]{display:none}
#display-mode{min-height:44px;min-width:44px;padding:0 12px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
#display-mode:focus-visible{outline:2px solid currentColor;outline-offset:2px}
#display-mode:disabled{opacity:.6;cursor:wait}
#canvas-viewport{min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;flex:1 1 auto}
#canvas-viewport:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
#root{padding:24px;box-sizing:border-box;display:flow-root;min-width:0;overflow-wrap:anywhere}
#root:empty{display:none}
#status{padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
#status:empty{display:none}
html[data-display-mode="fullscreen"] #canvas-shell,html[data-display-mode="pip"] #canvas-shell{height:100vh;height:100dvh;max-height:none}
html[data-display-mode="fullscreen"] #root,html[data-display-mode="pip"] #root{min-height:100%}
@media(max-width:480px){#root{padding:12px}#canvas-toolbar{padding:4px 8px}}
</style></head>
<body><div id="canvas-shell"><div id="canvas-toolbar" hidden><button id="display-mode" type="button" aria-label="Expand canvas">Expand</button></div><div id="canvas-viewport" tabindex="0" role="region" aria-label="Canvas"><div id="status" role="status">Waiting for canvas…</div><div id="root"></div></div></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

/** Compile a source snapshot without a loopback server or a Herdr process. */
export async function canvasAppResult(service: CanvasService, selection: { name?: string; version_id?: string; event_id?: string }) {
  if (Boolean(selection.name) === Boolean(selection.version_id)) throw new Error("provide name or version_id, but not both");
  if (selection.event_id && !selection.version_id) throw new Error("event_id requires version_id");
  const saved = selection.version_id ? service.version(selection.version_id) : undefined;
  const path = saved?.source_path ?? service.resolve(ensureCanvasFileName(selection.name!));
  if (!saved) assertRegularCanvas(path);
  const source = saved?.source ?? readFileSync(path, "utf8");
  const runtime = runtimeIdentity();
  const compiled = await compileCanvas(path, source);
  if (!compiled.ok || !compiled.js) return { ok: false, path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
  if (runtimeIdentity() !== runtime) throw new Error("Canvas SDK changed during compilation; retry");
  let state: Record<string, unknown> = {};
  if (saved) {
    const event = selection.event_id ? saved.events.find(event => event.id === selection.event_id) : saved.events.find(event => event.mode === "live") ?? saved.events[0];
    if (selection.event_id && !event) throw new Error("serve event not found for version");
    if (event) state = JSON.parse(event.initial_state);
  } else {
    try {
      const value: unknown = JSON.parse(readFileSync(path.replace(/\.canvas\.tsx$/, ".canvas.data.json"), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) state = value as Record<string, unknown>;
    } catch { /* Match gallery previews: malformed sidecars remain untouched. */ }
  }
  const history = new CanvasHistory(historyPath(service.env));
  try {
    const version = saved ?? history.capture({ workspace: service.canvasesDir, name: canvasIdFromFile(path), sourcePath: path, source, runtime });
    // Delivery records a preview event, not evidence that a human saw the app.
    const eventId = history.served(version.id, state, "preview", service.env, runtime);
    return {
      ok: true, path, check: formatCanvasCheck([]), diagnostics: [],
      canvas: { name: version.name, versionId: version.id, eventId, sourceHash: version.source_hash },
      _meta: { canvas: { name: version.name, versionId: version.id, eventId, sourceHash: version.source_hash, js: compiled.js, state } satisfies CanvasAppPayload },
    };
  } finally { history.close(); }
}
