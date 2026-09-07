import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CanvasAppPayload } from "../mcp/app";
import type { CanvasAction, HostBridge } from "../sdk/hooks";
import type { CanvasHttpRequest, CanvasHttpResponse } from "../sdk/server";

// Measure intrinsic content rather than the iframe's document height, so views
// can grow and shrink even when the host clamps or ignores a resize request.
const app = new App({ name: "Canvas", version: "0.1.0" }, {}, { autoResize: false });
const hostWindow = window as Window & { __herdrCanvas?: HostBridge; __herdrCanvasUnmount?: () => void };
const status = document.getElementById("status")!;
const shell = document.getElementById("canvas-shell")!;
const viewport = document.getElementById("canvas-viewport")!;
const root = document.getElementById("root")!;
const toolbar = document.getElementById("canvas-toolbar")!;
const displayButton = document.getElementById("display-mode") as HTMLButtonElement;
let script: HTMLScriptElement | undefined;
let context: McpUiHostContext = {};
let connected = false;
let hasCanvas = false;
let changingMode = false;
let sizeFrame = 0;
let lastHeight: number | undefined;
let inlineLimit = 600;
let fixedHeight: number | undefined;

function reportSize() {
  if (sizeFrame) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = 0;
    // Fullscreen/PiP dimensions belong to the host, not the canvas content.
    if (!connected || (context.displayMode && context.displayMode !== "inline")) return;
    const contentHeight = Math.max(root.getBoundingClientRect().height, root.scrollHeight)
      + status.getBoundingClientRect().height
      + (viewport.offsetHeight - viewport.clientHeight);
    const height = Math.max(1, Math.ceil(fixedHeight ?? Math.min(inlineLimit, contentHeight)));
    if (height === lastHeight) return;
    lastHeight = height;
    // Width always belongs to the host: reporting content width can create a
    // feedback loop with wrapping or wide charts.
    void app.sendSizeChanged({ height }).catch(() => { lastHeight = undefined; });
  });
}
const resizeObserver = new ResizeObserver(reportSize);
for (const element of [shell, viewport, root, status, toolbar]) resizeObserver.observe(element);

function updateDisplay() {
  const mode = context.displayMode ?? "inline";
  document.documentElement.dataset.displayMode = mode;
  const target = mode === "fullscreen" ? "inline" : "fullscreen";
  toolbar.hidden = !(hasCanvas || mode === "fullscreen") || !context.availableDisplayModes?.includes(target);
  displayButton.title = mode === "fullscreen" ? "Exit fullscreen" : "Expand canvas";
  displayButton.setAttribute("aria-label", mode === "fullscreen" ? "Exit fullscreen" : "Expand canvas");
  displayButton.disabled = changingMode;
  const dimensions = context.containerDimensions;
  const fixed = dimensions && "height" in dimensions ? dimensions.height : undefined;
  const maximum = dimensions && "maxHeight" in dimensions ? dimensions.maxHeight : undefined;
  const isSize = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const limit = isSize(fixed) ? fixed : isSize(maximum) ? Math.min(600, maximum) : 600;
  inlineLimit = limit;
  fixedHeight = isSize(fixed) ? fixed : undefined;
  shell.style.setProperty("--canvas-inline-limit", `${limit}px`);
  shell.style.setProperty("--canvas-fixed-height", isSize(fixed) ? `${fixed}px` : "auto");
  reportSize();
}

function applyContext(update: McpUiHostContext) {
  const previousMode = context.displayMode;
  context = { ...context, ...update };
  if (previousMode !== context.displayMode) lastHeight = undefined;
  theme(context.theme);
  updateDisplay();
}

displayButton.addEventListener("click", async () => {
  const target = context.displayMode === "fullscreen" ? "inline" : "fullscreen";
  if (changingMode || !context.availableDisplayModes?.includes(target)) return;
  changingMode = true;
  updateDisplay();
  try {
    const result = await app.requestDisplayMode({ mode: target });
    // A host may decline the request or choose a different supported mode.
    applyContext({ displayMode: result.mode });
    status.textContent = result.mode === target ? "" : "The chat host did not change the display mode.";
  } catch (error) {
    status.textContent = `Unable to change display mode: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    changingMode = false;
    updateDisplay();
  }
});

function theme(kind?: string) {
  const value = kind === "light" ? "light" : "dark";
  document.documentElement.style.setProperty("--canvas-background", value === "light" ? "#ffffff" : "#181818");
  document.documentElement.style.setProperty("--canvas-foreground", value === "light" ? "#181818" : "#f0f0f0");
  if (hostWindow.__herdrCanvas) hostWindow.__herdrCanvas.theme = { kind: value };
  window.dispatchEvent(new Event("canvas-theme-change"));
}

async function action(value: CanvasAction) {
  try {
    let result: { isError?: boolean };
    if (value.type === "openUrl") {
      if (!/^https?:\/\//i.test(value.url)) throw new Error("Only HTTP and HTTPS links can be opened from this canvas.");
      result = await app.openLink({ url: value.url });
    } else if (value.type === "promptAgent") {
      result = await app.sendMessage({ role: "user", content: [{ type: "text", text: value.prompt }] });
    } else {
      throw new Error(`Opening local files is unavailable in this chat: ${value.path}`);
    }
    if (result.isError) throw new Error("The chat host declined this canvas action.");
    status.textContent = "";
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}

async function serverRequest(canvas: CanvasAppPayload, request: CanvasHttpRequest): Promise<CanvasHttpResponse> {
  const result = await app.callServerTool({
    name: "canvas_request",
    arguments: { version_id: canvas.versionId, request },
  });
  if (result.isError) {
    const message = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
    throw new Error(message || "Canvas server request failed.");
  }
  const structured = result.structuredContent as { response?: CanvasHttpResponse } | undefined;
  if (!structured?.response) throw new Error("Canvas server response was missing.");
  return structured.response;
}

function clear() {
  hostWindow.__herdrCanvasUnmount?.();
  delete hostWindow.__herdrCanvasUnmount;
  script?.remove();
  root.replaceChildren();
  viewport.scrollTo(0, 0);
  hasCanvas = false;
  updateDisplay();
}

app.ontoolresult = result => {
  clear();
  if (result.isError) {
    status.textContent = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Canvas could not be rendered.";
    return;
  }
  const canvas = result._meta?.canvas as CanvasAppPayload | undefined;
  if (!canvas || typeof canvas.js !== "string") {
    status.textContent = "No canvas preview was returned.";
    return;
  }
  const bridge: HostBridge = { canvasId: canvas.name, state: canvas.state, onAction: value => { void action(value); } };
  if (canvas.server === true) bridge.onRequest = request => serverRequest(canvas, request);
  hostWindow.__herdrCanvas = bridge;
  hasCanvas = true;
  theme(context.theme);
  updateDisplay();
  status.textContent = "";
  // The host's MCP Apps sandbox/CSP contains this locally authored canvas.
  // Inline modules avoid eval, external assets, loopback fetches and blob URLs.
  script = document.createElement("script");
  script.type = "module";
  script.textContent = canvas.js;
  document.body.append(script);
};
app.ontoolcancelled = () => { clear(); status.textContent = "Canvas request cancelled."; };
app.onhostcontextchanged = applyContext;
window.addEventListener("error", event => { status.textContent = `Canvas error: ${event.message}`; });
window.addEventListener("unhandledrejection", event => { status.textContent = `Canvas error: ${String(event.reason)}`; });
app.connect().then(() => {
  connected = true;
  applyContext(app.getHostContext() ?? {});
}).catch(error => { status.textContent = `Unable to connect to chat: ${String(error)}`; });
