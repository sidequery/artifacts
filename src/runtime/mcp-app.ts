import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { ArtifactAppPayload } from "../mcp/app";
import type { ArtifactAction, HostBridge } from "../sdk/hooks";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "../sdk/server";
import { artifactFileTransferUrl } from "../sdk/files";
import { createMcpHost } from "./mcp-host";
import { mountArtifactFileEditor } from "./mcp-file-editor";
import { fetchArtifactPreview, mountWorkspace, parseArtifactDeepLink, type ArtifactSelection } from "./mcp-workspace";
import type { ArtifactWorkspacePayload } from "../mcp/workspace-contract";
import type { ArtifactModelContext } from "../sdk/hooks";
import { ARTIFACTS_DISPLAY_MODES } from "../mcp/host-contract";

// Measure intrinsic content rather than the iframe's document height, so views
// can grow and shrink even when the host clamps or ignores a resize request.
const app = new App({ name: "Artifacts", version: "0.1.0" }, { availableDisplayModes: [...ARTIFACTS_DISPLAY_MODES] }, { autoResize: false });
const host = createMcpHost(app);
const hostWindow = window as Window & { __artifacts?: HostBridge; __artifactsUnmount?: () => void; __herdrCanvas?: HostBridge; __herdrCanvasUnmount?: () => void };
const status = document.getElementById("status")!;
const shell = document.getElementById("artifact-shell")!;
const viewport = document.getElementById("artifact-viewport")!;
const root = document.getElementById("root")!;
const toolbar = document.getElementById("artifact-toolbar")!;
const displayButton = document.getElementById("display-mode") as HTMLButtonElement;
let script: HTMLScriptElement | undefined;
let activeArtifact: ArtifactAppPayload | undefined;
let disposeView: (() => void) | undefined;
let viewDisposal: Promise<void> = Promise.resolve();
let fileEditor: ReturnType<typeof mountArtifactFileEditor> | undefined;
let activeDeepLink: string | undefined;
let pendingContextId: string | undefined;
let opening = 0;
let contextEpoch = 0;
let lastWorkspace: ArtifactWorkspacePayload | undefined;
const controls = document.createElement("nav");
controls.setAttribute("aria-label", "Working artifact controls");
controls.hidden = true;
controls.className = "artifact-controls";
const libraryButton = document.createElement("button");
libraryButton.textContent = "Back to library";
const refreshButton = document.createElement("button");
refreshButton.textContent = "Refresh artifact";
const attachButton = document.createElement("button");
attachButton.textContent = "Attach artifact context";
controls.append(libraryButton, refreshButton, attachButton);
root.before(controls);
let context: McpUiHostContext = {};
let connected = false;
let hasArtifact = false;
let changingMode = false;
let sizeFrame = 0;
let lastHeight: number | undefined;
let inlineLimit = 600;
let fixedHeight: number | undefined;

function reportSize() {
  if (sizeFrame) return;
  sizeFrame = requestAnimationFrame(() => {
    sizeFrame = 0;
    // Fullscreen/PiP dimensions belong to the host, not the artifact content.
    if (!connected || (context.displayMode && context.displayMode !== "inline")) return;
    const contentHeight = Math.max(root.getBoundingClientRect().height, root.scrollHeight)
      + status.getBoundingClientRect().height + (controls.hidden ? 0 : controls.getBoundingClientRect().height)
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
for (const element of [shell, viewport, root, status, toolbar, controls]) resizeObserver.observe(element);

function updateDisplay() {
  const mode = context.displayMode ?? "inline";
  document.documentElement.dataset.displayMode = mode;
  const target = mode === "fullscreen" ? "inline" : "fullscreen";
  toolbar.hidden = !(hasArtifact || mode === "fullscreen") || !context.availableDisplayModes?.includes(target);
  displayButton.title = mode === "fullscreen" ? "Exit fullscreen" : "Expand artifact";
  displayButton.setAttribute("aria-label", mode === "fullscreen" ? "Exit fullscreen" : "Expand artifact");
  displayButton.disabled = changingMode;
  const dimensions = context.containerDimensions;
  const fixed = dimensions && "height" in dimensions ? dimensions.height : undefined;
  const maximum = dimensions && "maxHeight" in dimensions ? dimensions.maxHeight : undefined;
  const isSize = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const limit = isSize(fixed) ? fixed : isSize(maximum) ? Math.min(600, maximum) : 600;
  inlineLimit = limit;
  fixedHeight = isSize(fixed) ? fixed : undefined;
  shell.style.setProperty("--artifact-inline-limit", `${limit}px`);
  shell.style.setProperty("--artifact-fixed-height", isSize(fixed) ? `${fixed}px` : "auto");
  reportSize();
}

function applyContext(update: McpUiHostContext) {
  const previousMode = context.displayMode;
  context = { ...context, ...update };
  host.applyContext(context);
  const attachment = host.extensions.modelContext?.getCurrent();
  if (hostWindow.__artifacts && attachment !== undefined) {
    const bridge = hostWindow.__artifacts;
    const identity = attachment?.structuredContent?.artifact as { version_id?: string } | undefined;
    bridge.contextAttached = attachment !== null && identity?.version_id === activeArtifact?.versionId;
    if (!attachment) { contextEpoch++; bridge.modelContext = null; pendingContextId = undefined; }
    else if (!pendingContextId || attachment.updateId === pendingContextId) {
      bridge.modelContext = (bridge.contextAttached ? attachment.structuredContent?.view ?? null : null) as ArtifactModelContext | null;
    }
  }
  const deepLink = host.extensions.deepLink.getCurrent()?.url;
  if (deepLink && deepLink !== activeDeepLink) {
    activeDeepLink = deepLink;
    const selection = parseArtifactDeepLink(deepLink);
    if (selection) void openSelection(selection).catch(error => { status.textContent = String(error); });
  }
  if (hostWindow.__artifacts) {
    hostWindow.__artifacts.environment = { locale: context.locale, timeZone: context.timeZone };
    window.dispatchEvent(new Event("artifact-host-context-change"));
  }
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
  document.documentElement.style.setProperty("--artifact-background", value === "light" ? "#ffffff" : "#181818");
  document.documentElement.style.setProperty("--artifact-foreground", value === "light" ? "#181818" : "#f0f0f0");
  if (hostWindow.__artifacts) hostWindow.__artifacts.theme = { kind: value };
  window.dispatchEvent(new Event("artifact-theme-change"));
  window.dispatchEvent(new Event("canvas-theme-change"));
}

async function action(value: ArtifactAction) {
  try {
    const result: { isError?: boolean } = await host.action(value);
    if (result.isError) throw new Error("The chat host declined this artifact action.");
    status.textContent = "";
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}

async function serverRequest(artifact: ArtifactAppPayload, request: ArtifactHttpRequest): Promise<ArtifactHttpResponse> {
  const result = await app.callServerTool({
    name: "artifact_request",
    arguments: { version_id: artifact.versionId, ...(artifact.workspace ? { workspace: artifact.workspace } : {}), request },
  });
  if (result.isError) {
    const message = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
    throw new Error(message || "Artifact server request failed.");
  }
  const structured = result.structuredContent as { response?: ArtifactHttpResponse } | undefined;
  if (!structured?.response) throw new Error("Artifact server response was missing.");
  return structured.response;
}

function clear() {
  disposeView?.();
  disposeView = undefined;
  if (fileEditor) {
    const disposal = fileEditor.dispose();
    viewDisposal = Promise.all([viewDisposal, disposal]).then(() => {});
    fileEditor = undefined;
  }
  activeArtifact = undefined;
  controls.hidden = true;
  for (const unmount of new Set([hostWindow.__artifactsUnmount, hostWindow.__herdrCanvasUnmount])) unmount?.();
  delete hostWindow.__artifactsUnmount;
  delete hostWindow.__herdrCanvasUnmount;
  delete hostWindow.__artifacts;
  delete hostWindow.__herdrCanvas;
  script?.remove();
  root.replaceChildren();
  viewport.scrollTo(0, 0);
  hasArtifact = false;
  updateDisplay();
}

async function openSelection(selection: ArtifactSelection) {
  if (fileEditor?.hasUnsavedChanges()) throw new Error("Save or discard the file draft before opening another view.");
  if (!host.capabilities().serverTools) throw new Error("Browsing artifacts is unavailable in this host.");
  const request = ++opening;
  const artifact = await fetchArtifactPreview(app, selection);
  if (request !== opening) return;
  renderArtifact(artifact, selection.route, true);
}

function renderArtifact(artifact: ArtifactAppPayload, route?: string, preserve = false) {
  const previous = hostWindow.__artifacts;
  const compatible = preserve && activeArtifact?.name === artifact.name && activeArtifact?.workspace === artifact.workspace;
  const state = compatible ? { ...artifact.state, ...previous?.state } : artifact.state;
  const restored = host.extensions.modelContext?.getCurrent();
  const restoredIdentity = restored?.structuredContent?.artifact as { version_id?: string } | undefined;
  const restore = restoredIdentity?.version_id === artifact.versionId;
  const modelContext = compatible ? previous?.modelContext : restore ? (restored?.structuredContent?.view ?? null) as ArtifactModelContext | null : null;
  const contextAttached = compatible ? previous?.contextAttached && activeArtifact?.versionId === artifact.versionId : restore;
  const previousRoute = compatible ? previous?.route?.path : undefined;
  clear();
  activeArtifact = artifact;
  const capabilities = host.capabilities();
  const bridge: HostBridge & { canvasId: string } = {
    canvasId: artifact.name, artifactId: artifact.name, state,
    route: { path: route ?? previousRoute ?? "/", basePath: "", external: true, transport: "mcp" },
    modelContext, contextAttached,
    actions: capabilities.actions, environment: { locale: context.locale, timeZone: context.timeZone },
    onAction: value => { void action(value); },
  };
  if (capabilities.modelContext) bridge.onModelContext = async view => {
    const epoch = contextEpoch;
    const snapshot = view === null ? undefined : { artifact: { name: artifact.name, workspace: artifact.workspace, version_id: artifact.versionId, revision: artifact.revision }, view };
    const result = await host.updateContext(snapshot ? { structuredContent: snapshot, content: [{ type: "text", text: JSON.stringify(snapshot) }] } : { content: [], structuredContent: {} });
    // A late acknowledgement cannot attach context to a replacement view.
    if (hostWindow.__artifacts !== bridge || epoch !== contextEpoch) return;
    pendingContextId = result?.updateId;
    bridge.modelContext = view;
    bridge.contextAttached = view !== null;
    window.dispatchEvent(new Event("artifact-host-context-change"));
  };
  if (artifact.server === true && capabilities.serverTools) bridge.onRequest = request => serverRequest(artifact, request);
  if (artifact.files === true && capabilities.serverTools) {
    bridge.onFileRequest = async request => {
      const result = await app.callServerTool({ name: "artifact_files", arguments: { version_id: artifact.versionId, ...(artifact.workspace ? { workspace: artifact.workspace } : {}), request } });
      if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Artifact file request failed");
      if (!result.structuredContent || !Object.hasOwn(result.structuredContent, "result")) throw new Error("Artifact file result was missing");
      return result.structuredContent.result;
    };
    bridge.onFileDownload = async url => {
      const result = await app.openLink({ url: artifactFileTransferUrl(url) });
      if (result.isError) throw new Error("The chat host declined the file download.");
    };
  }
  if (artifact.plugins === true && capabilities.serverTools) bridge.onPluginCall = async request => {
    const result = await app.callServerTool({ name: "artifact_plugin_call", arguments: { ...request } });
    if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Plugin call failed");
    const structured = result.structuredContent;
    if (!structured || !Object.hasOwn(structured, "result")) throw new Error("Plugin result was missing");
    return structured.result;
  };
  hostWindow.__artifacts = hostWindow.__herdrCanvas = bridge;
  hasArtifact = true;
  controls.hidden = !preserve;
  libraryButton.hidden = !lastWorkspace;
  attachButton.hidden = !capabilities.modelContext;
  theme(context.theme);
  updateDisplay();
  status.textContent = "";
  // The host's MCP Apps sandbox/CSP contains this locally authored artifact.
  // Inline modules avoid eval, external assets, loopback fetches and blob URLs.
  script = document.createElement("script");
  script.type = "module";
  script.textContent = artifact.js;
  document.body.append(script);
}
app.ontoolresult = result => {
  if (fileEditor?.hasUnsavedChanges()) { status.textContent = "Save or discard the file draft before replacing this view."; return; }
  if (result.structuredContent?.file && !result.isError) return;
  ++opening;
  if (result.isError) { status.textContent = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Artifact could not be rendered."; return; }
  const artifact = result._meta?.artifact as ArtifactAppPayload | undefined;
  if (artifact?.js) { renderArtifact(artifact); return; }
  const workspace = result._meta?.workspace as ArtifactWorkspacePayload | undefined;
  if (workspace) {
    clear();
    status.textContent = "";
    hasArtifact = true;
    lastWorkspace = workspace;
    disposeView = mountWorkspace(root, app, workspace, openSelection);
    updateDisplay();
    // Each thread gets its own host instance. Reopen its explicit attachment,
    // with fresh authorization, without inventing a server-side chat identity.
    const attached = host.extensions.modelContext?.getCurrent();
    const selected = attached?.structuredContent?.artifact as { name?: unknown; workspace?: unknown; version_id?: unknown } | undefined;
    if (workspace.view === "working" && typeof selected?.version_id === "string" && typeof selected.workspace === "string") {
      const view = attached?.structuredContent?.view as ArtifactModelContext | undefined;
      const route = typeof view?.route === "string" && view.route.startsWith("/") && !view.route.startsWith("//") ? view.route : "/";
      void openSelection({ workspace: selected.workspace, version_id: selected.version_id, route }).catch(error => { status.textContent = String(error); });
    }
    return;
  }
  // Diagnostics-only mutations deliberately leave the working view mounted.
};
app.ontoolinput = async ({ arguments: args }) => {
  const file = args?.file as { resourceUri?: string; name?: string } | undefined;
  if (!file || typeof file.resourceUri !== "string" || typeof file.name !== "string") return;
  if (fileEditor?.hasUnsavedChanges()) { status.textContent = "Save or discard the file draft before opening another file."; return; }
  const request = ++opening;
  clear();
  await viewDisposal;
  if (request !== opening) return;
  fileEditor = mountArtifactFileEditor(root, host.extensions, { file: { resourceUri: file.resourceUri, name: file.name } });
  hasArtifact = true;
  status.textContent = "";
  updateDisplay();
};
window.addEventListener("artifact/navigate", event => {
  const detail = (event as CustomEvent<{ path: string; action: string }>).detail;
  if (hostWindow.__artifacts?.route) hostWindow.__artifacts.route.path = detail.path;
});
libraryButton.addEventListener("click", () => {
  if (!lastWorkspace) return;
  clear();
  hasArtifact = true;
  disposeView = mountWorkspace(root, app, lastWorkspace, openSelection);
  updateDisplay();
});
refreshButton.addEventListener("click", () => {
  if (activeArtifact) void openSelection({ workspace: activeArtifact.workspace, name: activeArtifact.name }).catch(error => { status.textContent = String(error); });
});
attachButton.addEventListener("click", () => {
  const bridge = hostWindow.__artifacts;
  if (bridge?.onModelContext) void bridge.onModelContext({ ...bridge.modelContext, route: bridge.route?.path ?? "/" }).catch(error => { status.textContent = String(error); });
});
app.ontoolcancelled = () => { ++opening; if (fileEditor?.hasUnsavedChanges()) { status.textContent = "Request cancelled. Your unsaved file draft is preserved."; return; } clear(); status.textContent = "Artifact request cancelled."; };
app.onteardown = async () => {
  ++opening;
  resizeObserver.disconnect();
  if (sizeFrame) cancelAnimationFrame(sizeFrame);
  clear();
  await viewDisposal;
  return {};
};
app.onhostcontextchanged = applyContext;
window.addEventListener("error", event => { status.textContent = `Artifact error: ${event.message}`; });
window.addEventListener("unhandledrejection", event => { status.textContent = `Artifact error: ${String(event.reason)}`; });
app.connect().then(() => {
  connected = true;
  applyContext(app.getHostContext() ?? {});
}).catch(error => { status.textContent = `Unable to connect to chat: ${String(error)}`; });
