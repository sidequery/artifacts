import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canvasIdFromFile, assertRegularCanvas, ensureCanvasFileName } from "../canvasFile";
import { compileCanvas } from "../compile";
import { formatCanvasCheck } from "../diagnostics";
import { CanvasHistory, historyPath, runtimeIdentity } from "../history";
import { PLUGIN_ROOT } from "../paths";
import type { CanvasService } from "../service";

export * from "./app-contract";
import type { CanvasAppPayload } from "./app-contract";

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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sidequery Canvas</title>
<style>
html,body{margin:0;font-family:system-ui,sans-serif;overflow:hidden}
html,body{background:transparent}
body{color:var(--canvas-foreground,#f0f0f0)}
#canvas-shell{position:relative;isolation:isolate;display:flex;flex-direction:column;max-height:min(var(--canvas-inline-limit,600px),100vh);max-height:min(var(--canvas-inline-limit,600px),100dvh);height:var(--canvas-fixed-height,auto);min-width:0}
#canvas-toolbar{position:absolute;top:8px;right:8px;z-index:1}
#canvas-toolbar[hidden]{display:none}
#display-mode{display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:12px;background:color-mix(in srgb,var(--canvas-background,#181818) 72%,transparent);color:inherit;box-shadow:0 1px 4px #0002,inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent);backdrop-filter:blur(12px);cursor:pointer}
@media(hover:hover){#display-mode:hover{background:color-mix(in srgb,var(--canvas-background,#181818) 92%,transparent)}}
#display-mode:active{box-shadow:inset 0 0 0 1px currentColor}
#display-mode:focus-visible{outline:2px solid currentColor;outline-offset:2px}
#display-mode:disabled{opacity:.6;cursor:wait}
#display-mode-icon{position:relative;width:16px;height:16px;pointer-events:none}
#display-mode-icon::before,#display-mode-icon::after{content:"";position:absolute;width:6px;height:6px;border:solid currentColor}
#display-mode-icon::before{top:0;right:0;border-width:1.5px 1.5px 0 0}
#display-mode-icon::after{bottom:0;left:0;border-width:0 0 1.5px 1.5px}
html[data-display-mode="fullscreen"] #display-mode-icon::before{border-width:0 0 1.5px 1.5px}
html[data-display-mode="fullscreen"] #display-mode-icon::after{border-width:1.5px 1.5px 0 0}
#canvas-viewport{min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;flex:1 1 auto}
#canvas-viewport:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
#root{padding:24px;box-sizing:border-box;display:flow-root;min-width:0;overflow-wrap:anywhere}
#root:empty{display:none}
#status{padding:12px;white-space:pre-wrap;overflow-wrap:anywhere}
#status:empty{display:none}
html[data-display-mode="fullscreen"] #canvas-shell,html[data-display-mode="pip"] #canvas-shell{height:100vh;height:100dvh;max-height:none}
html[data-display-mode="fullscreen"] #root,html[data-display-mode="pip"] #root{min-height:100%}
@media(max-width:480px){#root{padding:12px}}
</style></head>
<body><div id="canvas-shell"><div id="canvas-toolbar" hidden><button id="display-mode" type="button" aria-label="Expand canvas" title="Expand canvas"><span id="display-mode-icon" aria-hidden="true"></span></button></div><div id="canvas-viewport" tabindex="0" role="region" aria-label="Canvas"><div id="status" role="status">Waiting for canvas…</div><div id="root"></div></div></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
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
