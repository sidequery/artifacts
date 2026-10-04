import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { ArtifactAppPayload } from "../mcp/app";
import type { HostBridge } from "../sdk/hooks";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "../sdk/server";
import { artifactFileTransferUrl } from "../sdk/files";
import { createMcpHost } from "./mcp-host";
import { mountArtifactFileEditor } from "./mcp-file-editor";
import { fetchArtifactPreview, mountWorkspace, parseArtifactDeepLink, type ArtifactSelection } from "./mcp-workspace";
import type { ArtifactWorkspacePayload } from "../mcp/workspace-contract";
import type { ArtifactModelContext } from "../sdk/hooks";
import { ARTIFACTS_DISPLAY_MODES } from "../mcp/host-contract";
import { mountMcpPreview } from "./mcp-preview";
import type { GalleryArtifact } from "../gallery/types";

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
let viewDisposal: Promise<void> = Promise.resolve();
let fileEditor: ReturnType<typeof mountArtifactFileEditor> | undefined;
let activeDeepLink: string | undefined;
let pendingContextId: string | undefined;
let opening = 0;
let contextEpoch = 0;
let lastWorkspace: ArtifactWorkspacePayload | undefined;
let workspaceView: ReturnType<typeof mountWorkspace> | undefined;
let selectedArtifact: ArtifactSelection | undefined;
const activeBridges = new Set<HostBridge>();
const previews = new Set<ReturnType<typeof mountMcpPreview>>();
const previewState = new Map<string, Pick<HostBridge, "state" | "route">>();
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
    // Fullscreen dimensions belong to the host, not the artifact content.
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
  toolbar.hidden = document.documentElement.dataset.view === "workspace" || document.documentElement.dataset.view === "file" || !(hasArtifact || mode === "fullscreen") || !context.availableDisplayModes?.includes(target);
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
  for (const bridge of activeBridges) {
    if (attachment === undefined) continue;
    const identity = attachment?.structuredContent?.artifact as { version_id?: string } | undefined;
    bridge.contextAttached = attachment !== null && identity?.version_id === bridgeVersions.get(bridge);
    if (!attachment) { contextEpoch++; bridge.modelContext = null; pendingContextId = undefined; }
    else if (!pendingContextId || attachment.updateId === pendingContextId) {
      bridge.modelContext = (bridge.contextAttached ? attachment.structuredContent?.view ?? null : null) as ArtifactModelContext | null;
    }
  }
  const attachedIdentity = attachment?.structuredContent?.artifact as { version_id?: string } | undefined;
  workspaceView?.update({ attachedVersionId: attachedIdentity?.version_id });
  const deepLink = host.extensions.deepLink.getCurrent()?.url;
  if (deepLink && deepLink !== activeDeepLink) {
    activeDeepLink = deepLink;
    const selection = parseArtifactDeepLink(deepLink);
    if (selection) void openSelection(selection).catch(error => { status.textContent = String(error); });
  }
  for (const bridge of activeBridges) bridge.environment = { locale: context.locale, timeZone: context.timeZone };
  window.dispatchEvent(new Event("artifact-host-context-change"));
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
  document.documentElement.dataset.theme = value;
  document.documentElement.style.setProperty("--artifact-background", value === "light" ? "#ffffff" : "#181818");
  document.documentElement.style.setProperty("--artifact-foreground", value === "light" ? "#181818" : "#f0f0f0");
  for (const bridge of activeBridges) bridge.theme = { kind: value };
  for (const preview of previews) preview.update();
  window.dispatchEvent(new Event("artifact-theme-change"));
  window.dispatchEvent(new Event("canvas-theme-change"));
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
  workspaceView?.dispose();
  workspaceView = undefined;
  for (const preview of previews) preview.dispose();
  previews.clear();
  activeBridges.clear();
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
  document.documentElement.dataset.view = "artifact";
  root.style.removeProperty("padding");
  root.style.removeProperty("height");
  viewport.style.removeProperty("overflow");
  updateDisplay();
}

async function openSelection(selection: ArtifactSelection) {
  if (fileEditor?.hasUnsavedChanges()) throw new Error("Save or discard the file draft before opening another view.");
  if (!host.capabilities().serverTools) throw new Error("Browsing artifacts is unavailable in this host.");
  selectedArtifact = selection;
  if (workspaceView) { workspaceView.update({ selection }); return; }
  const request = ++opening;
  const artifact = await fetchArtifactPreview(app, selection);
  if (request !== opening) return;
  renderArtifact(artifact, selection.route, true);
}

const bridgeVersions = new WeakMap<HostBridge, string>();

function createArtifactBridge(artifact: ArtifactAppPayload, route?: string, previous?: Pick<HostBridge, "state" | "route">) {
  const restored = host.extensions.modelContext?.getCurrent();
  const identity = restored?.structuredContent?.artifact as { version_id?: string } | undefined;
  const attached = identity?.version_id === artifact.versionId;
  const capabilities = host.capabilities();
  const bridge: HostBridge = {
    artifactId: artifact.name,
    state: { ...artifact.state, ...previous?.state },
    route: { path: route ?? previous?.route?.path ?? "/", basePath: "", external: true, transport: "mcp" },
    modelContext: attached ? (restored?.structuredContent?.view ?? null) as ArtifactModelContext | null : null,
    contextAttached: attached,
    theme: { kind: context.theme === "light" ? "light" : "dark" },
    actions: capabilities.actions,
    environment: { locale: context.locale, timeZone: context.timeZone },
    onAction: value => host.action(value).then(result => {
      if (result.isError) throw new Error("The chat host declined this artifact action.");
    }),
  };
  activeBridges.add(bridge);
  bridgeVersions.set(bridge, artifact.versionId);
  if (capabilities.modelContext) bridge.onModelContext = async view => {
    const epoch = contextEpoch;
    const snapshot = view === null ? undefined : { artifact: { name: artifact.name, workspace: artifact.workspace, version_id: artifact.versionId, revision: artifact.revision }, view };
    const result = await host.updateContext(snapshot ? {
      structuredContent: snapshot,
      content: [{ type: "text", text: JSON.stringify(snapshot), _meta: { "openai/title": artifact.name } }],
    } : { content: [], structuredContent: {} });
    if (!activeBridges.has(bridge) || epoch !== contextEpoch) return;
    pendingContextId = result?.updateId;
    bridge.modelContext = view;
    bridge.contextAttached = view !== null;
    workspaceView?.update({ attachedVersionId: view !== null ? artifact.versionId : undefined });
    attachButton.textContent = view !== null ? "Update conversation context" : "Use in conversation";
    for (const preview of previews) preview.update();
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
  return bridge;
}

function renderArtifact(artifact: ArtifactAppPayload, route?: string, preserve = false) {
  const previous = preserve && activeArtifact?.name === artifact.name && activeArtifact?.workspace === artifact.workspace ? hostWindow.__artifacts : undefined;
  clear();
  activeArtifact = artifact;
  const bridge = createArtifactBridge(artifact, route, previous);
  hostWindow.__artifacts = hostWindow.__herdrCanvas = bridge;
  hasArtifact = true;
  controls.hidden = !preserve;
  libraryButton.hidden = !lastWorkspace;
  attachButton.hidden = !host.capabilities().modelContext;
  theme(context.theme);
  updateDisplay();
  status.textContent = "";
  // Inline tool results render the authored artifact immediately.
  script = document.createElement("script");
  script.type = "module";
  script.textContent = artifact.js;
  document.body.append(script);
}

async function renderWorkspacePreview(container: HTMLElement, item: GalleryArtifact, version: string, route?: string) {
  const selection = { workspace: item.workspace, ...(version === "working" ? { name: item.name } : { version_id: version }) };
  const artifact = await fetchArtifactPreview(app, selection);
  if (!container.isConnected) return () => {};
  const key = JSON.stringify([item.key, version]);
  const previous = previewState.get(key);
  const bridge = createArtifactBridge(artifact, previous?.route?.path ?? route, previous);
  const preview = mountMcpPreview(container, artifact.js, bridge, message => { status.textContent = message; });
  previews.add(preview);
  return () => {
    previewState.set(key, { state: bridge.state, route: bridge.route });
    activeBridges.delete(bridge); previews.delete(preview); preview.dispose();
  };
}

async function attachWorkspaceArtifact(item: GalleryArtifact, version: string) {
  const bridge = [...activeBridges].find(value => value.artifactId === item.name && (version === "working" || bridgeVersions.get(value) === version));
  if (bridge?.onModelContext) {
    await bridge.onModelContext({ ...bridge.modelContext, route: bridge.route?.path ?? "/" });
    return;
  }
  const artifact = await fetchArtifactPreview(app, { workspace: item.workspace, ...(version === "working" ? { name: item.name } : { version_id: version }) });
  const temporary = createArtifactBridge(artifact);
  try {
    if (!temporary.onModelContext) throw new Error("Adding context is unavailable in this chat");
    await temporary.onModelContext({ route: "/" });
  } finally { activeBridges.delete(temporary); }
}

function showWorkspace(workspace: ArtifactWorkspacePayload) {
  clear();
  status.textContent = "";
  hasArtifact = true;
  lastWorkspace = workspace;
  document.documentElement.dataset.view = "workspace";
  root.style.padding = "0";
  root.style.height = "100%";
  viewport.style.overflow = "hidden";
  const attached = host.extensions.modelContext?.getCurrent();
  const identity = attached?.structuredContent?.artifact as ArtifactSelection | undefined;
  const view = attached?.structuredContent?.view as ArtifactModelContext | undefined;
  const restored = workspace.view === "working" && identity?.version_id ? { ...identity, route: view?.route ?? "/" } : undefined;
  workspaceView = mountWorkspace(root, app, workspace, {
    selection: selectedArtifact ?? restored,
    attachedVersionId: identity?.version_id,
    renderPreview: renderWorkspacePreview,
    attach: attachWorkspaceArtifact,
    onSelectionChange: selection => { selectedArtifact = selection; },
    openLink: async url => {
      const result = await app.openLink({ url });
      if (result.isError) throw new Error("The host could not open the link");
    },
    ...(workspace.productUrl ? { openProduct: async () => {
      const result = await app.openLink({ url: workspace.productUrl! });
      if (result.isError) throw new Error("The host could not open the library");
    } } : {}),
    ...(host.capabilities().actions.promptAgent ? { askCreate: async () => {
      const result = await host.action({ type: "promptAgent", prompt: "Help me create a new artifact in my connected Artifacts library. Ask what I want to build before creating it." });
      if (result.isError) throw new Error("The host could not send the request");
    } } : {}),
  });
  updateDisplay();
}
app.ontoolresult = result => {
  if (fileEditor?.hasUnsavedChanges()) { status.textContent = "Save or discard the file draft before replacing this view."; return; }
  if (result.structuredContent?.file && !result.isError) return;
  ++opening;
  if (result.isError) { status.textContent = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Artifact could not be rendered."; return; }
  const artifact = result._meta?.artifact as ArtifactAppPayload | undefined;
  if (artifact?.js) {
    if (workspaceView) { workspaceView.refresh(); return; }
    renderArtifact(artifact); return;
  }
  const workspace = result._meta?.workspace as ArtifactWorkspacePayload | undefined;
  if (workspace) {
    if (workspaceView && lastWorkspace?.view === workspace.view) workspaceView.refresh();
    else showWorkspace(workspace);
    return;
  }
  // Diagnostics-only mutations deliberately leave the working view mounted.
  workspaceView?.refresh();
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
  document.documentElement.dataset.view = "file";
  root.style.padding = "0";
  root.style.height = "100%";
  viewport.style.overflow = "hidden";
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
  showWorkspace(lastWorkspace);
});
refreshButton.addEventListener("click", () => {
  if (activeArtifact) void openSelection(selectedArtifact ?? { workspace: activeArtifact.workspace, version_id: activeArtifact.versionId }).catch(error => { status.textContent = String(error); });
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
// Moving focus from the preview frame to its toolbar must not reload the artifact.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") workspaceView?.refresh();
});
window.addEventListener("error", event => { status.textContent = `Artifact error: ${event.message}`; });
window.addEventListener("unhandledrejection", event => { status.textContent = `Artifact error: ${String(event.reason)}`; });
app.connect().then(() => {
  connected = true;
  applyContext(app.getHostContext() ?? {});
}).catch(error => { status.textContent = `Unable to connect to chat: ${String(error)}`; });
