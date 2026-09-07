import { App } from "@modelcontextprotocol/ext-apps";
import type { CanvasAppPayload } from "../mcpApp";
import type { CanvasAction, HostBridge } from "../sdk/hooks";

const app = new App({ name: "Canvas", version: "0.1.0" }, {}, { autoResize: true });
const hostWindow = window as Window & { __herdrCanvas?: HostBridge; __herdrCanvasUnmount?: () => void };
const status = document.getElementById("status")!;
let script: HTMLScriptElement | undefined;

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

function clear() {
  hostWindow.__herdrCanvasUnmount?.();
  delete hostWindow.__herdrCanvasUnmount;
  script?.remove();
  document.getElementById("root")!.replaceChildren();
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
  hostWindow.__herdrCanvas = { canvasId: canvas.name, state: canvas.state, onAction: value => { void action(value); } };
  theme(app.getHostContext()?.theme);
  status.textContent = "";
  // The host's MCP Apps sandbox/CSP contains this locally authored canvas.
  // Inline modules avoid eval, external assets, loopback fetches and blob URLs.
  script = document.createElement("script");
  script.type = "module";
  script.textContent = canvas.js;
  document.body.append(script);
};
app.ontoolcancelled = () => { clear(); status.textContent = "Canvas request cancelled."; };
app.onhostcontextchanged = context => theme(context.theme ?? app.getHostContext()?.theme);
window.addEventListener("error", event => { status.textContent = `Canvas error: ${event.message}`; });
window.addEventListener("unhandledrejection", event => { status.textContent = `Canvas error: ${String(event.reason)}`; });
app.connect().then(() => theme(app.getHostContext()?.theme)).catch(error => { status.textContent = `Unable to connect to chat: ${String(error)}`; });
