import {
  AppBridge,
  PostMessageTransport,
  type McpUiDisplayMode,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type RequestBehavior = "accept" | "decline" | "throw";

declare global {
  interface Window {
    artifactAppHtml: string;
    initialServerToolResult?: CallToolResult;
    mcpHost?: {
      initialized: boolean;
      messages: unknown[];
      modelContexts: unknown[];
      removeModelContext(): void;
      sandboxReady: boolean;
      links: string[];
      sizeChanges: Array<{ width?: number; height?: number }>;
      requestedModes: McpUiDisplayMode[];
      serverToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
      sendResult(result: CallToolResult): Promise<void>;
      cancel(reason: string): Promise<void>;
      setTheme(theme: "dark" | "light"): void;
      configure(update: Partial<McpUiHostContext>): void;
      setInlineFrameLimit(limit?: number): void;
      setRequestBehavior(behavior: RequestBehavior): void;
      setServerToolResult(result: CallToolResult): void;
      context(): McpUiHostContext;
    };
  }
}

const iframe = document.querySelector<HTMLIFrameElement>("#app")!;
const messages: unknown[] = [];
const modelContexts: unknown[] = [];
const options = new URLSearchParams(location.search);
const minimal = options.get("host") === "minimal";
const openai = options.get("host") === "openai";
const proxy = options.has("proxy");
const links: string[] = [];
const sizeChanges: Array<{ width?: number; height?: number }> = [];
const requestedModes: McpUiDisplayMode[] = [];
const serverToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
let serverToolResult: CallToolResult = window.initialServerToolResult ?? { content: [], structuredContent: {
  response: { status: 200, statusText: "OK", headers: [] },
} };
let requestBehavior: RequestBehavior = "accept";
let lastRequestedHeight = 1;
let inlineFrameLimit: number | undefined;
let hostContext: McpUiHostContext = {
  theme: "dark",
  displayMode: "inline",
  availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: { width: 640, maxHeight: 600 },
  ...(options.has("deepLink") ? { "openai/deepLink": { url: options.get("deepLink")! } } : {}),
};

const bridge = new AppBridge(
  null,
  { name: "Artifact browser test host", version: "1.0.0" },
  minimal ? {} : { message: { text: {} }, openLinks: {}, serverTools: {}, updateModelContext: { text: {} }, ...(openai ? { experimental: { "openai/modelContext": {} } } : {}) },
  { hostContext },
);

function applyFrameSize() {
  const mode = hostContext.displayMode ?? "inline";
  const dimensions = hostContext.containerDimensions;
  if (mode === "fullscreen") {
    iframe.style.width = `${window.innerWidth - 32}px`;
    iframe.style.height = `${window.innerHeight - 32}px`;
    return;
  }
  const width = dimensions && "width" in dimensions ? dimensions.width : dimensions?.maxWidth;
  if (width !== undefined) iframe.style.width = `${width}px`;
  if (dimensions && "height" in dimensions) {
    iframe.style.height = `${dimensions.height}px`;
    return;
  }
  const maxHeight = dimensions?.maxHeight;
  iframe.style.height = `${Math.min(lastRequestedHeight, maxHeight ?? lastRequestedHeight, inlineFrameLimit ?? lastRequestedHeight)}px`;
}

window.mcpHost = {
  initialized: false,
  sandboxReady: false,
  modelContexts,
  removeModelContext() {
    hostContext = { ...hostContext, "openai/modelContext": null };
    bridge.setHostContext(hostContext);
  },
  messages,
  links,
  sizeChanges,
  requestedModes,
  serverToolCalls,
  async sendResult(result) {
    await bridge.sendToolResult(result);
  },
  async cancel(reason) {
    await bridge.sendToolCancelled({ reason });
  },
  setTheme(theme) {
    hostContext = { ...hostContext, theme };
    bridge.setHostContext(hostContext);
  },
  configure(update) {
    hostContext = { ...hostContext, ...update };
    applyFrameSize();
    bridge.setHostContext(hostContext);
  },
  setInlineFrameLimit(limit) {
    inlineFrameLimit = limit;
    applyFrameSize();
  },
  setRequestBehavior(behavior) {
    requestBehavior = behavior;
  },
  setServerToolResult(result) {
    serverToolResult = result;
  },
  context() {
    return structuredClone(hostContext);
  },
};

bridge.onsizechange = change => {
  sizeChanges.push(change);
  if (change.height !== undefined) lastRequestedHeight = change.height;
  if ((hostContext.displayMode ?? "inline") === "inline") applyFrameSize();
};
bridge.onrequestdisplaymode = async ({ mode }) => {
  requestedModes.push(mode);
  if (requestBehavior === "throw") throw new Error("Display mode request failed in host");
  const current = hostContext.displayMode ?? "inline";
  if (requestBehavior === "decline" || !hostContext.availableDisplayModes?.includes(mode)) return { mode: current };
  hostContext = { ...hostContext, displayMode: mode };
  applyFrameSize();
  bridge.setHostContext(hostContext);
  return { mode };
};
bridge.oncalltool = async params => {
  serverToolCalls.push(params);
  return serverToolResult;
};
bridge.onupdatemodelcontext = async params => {
  modelContexts.push(params);
  if (!openai) return {};
  const updateId = `context-${modelContexts.length}`;
  hostContext = { ...hostContext, "openai/modelContext": { ...params, updateId } };
  bridge.setHostContext(hostContext);
  return { _meta: { "openai/modelContext": { updateId } } };
};
bridge.onmessage = async params => {
  messages.push(params);
  return {};
};
bridge.onopenlink = async ({ url }) => {
  links.push(url);
  return {};
};
bridge.oninitialized = () => {
  window.mcpHost!.initialized = true;
};

applyFrameSize();
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
if (proxy) {
  bridge.onsandboxready = async () => {
    window.mcpHost!.sandboxReady = true;
    await bridge.sendSandboxResourceReady({ html: window.artifactAppHtml, sandbox: "allow-scripts" });
  };
  iframe.src = "/sandbox-proxy";
} else iframe.srcdoc = window.artifactAppHtml;
