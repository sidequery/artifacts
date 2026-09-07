import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

declare global {
  interface Window {
    canvasAppHtml: string;
    mcpHost?: {
      initialized: boolean;
      messages: unknown[];
      links: string[];
      sendResult(result: CallToolResult): Promise<void>;
      cancel(reason: string): Promise<void>;
      setTheme(theme: "dark" | "light"): void;
    };
  }
}

const iframe = document.querySelector<HTMLIFrameElement>("#app")!;
const messages: unknown[] = [];
const links: string[] = [];
const bridge = new AppBridge(
  null,
  { name: "Canvas browser test host", version: "1.0.0" },
  { message: { text: {} }, openLinks: {} },
  { hostContext: { theme: "dark" } },
);

window.mcpHost = {
  initialized: false,
  messages,
  links,
  async sendResult(result) {
    await bridge.sendToolResult(result);
  },
  async cancel(reason) {
    await bridge.sendToolCancelled({ reason });
  },
  setTheme(theme) {
    bridge.setHostContext({ theme });
  },
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

await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.srcdoc = window.canvasAppHtml;
