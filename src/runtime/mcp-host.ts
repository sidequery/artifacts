import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { ArtifactHostActions } from "../sdk/hooks";

/** OpenAI APIs stay here; artifact source consumes the portable SDK bridge. */
export function createMcpHost(app: App) {
  const extensions = new OpenAIExtensions(app);
  return {
    extensions,
    capabilities() {
      const host = app.getHostCapabilities();
      const actions: ArtifactHostActions = {
        openUrl: host?.openLinks !== undefined,
        promptAgent: host?.message?.text !== undefined,
        openFile: extensions.files !== undefined,
      };
      return { actions, serverTools: host?.serverTools !== undefined, modelContext: host?.updateModelContext?.text !== undefined };
    },
    applyContext(context: McpUiHostContext) {
      if (context.theme) applyDocumentTheme(context.theme);
      if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
      if (context.locale) document.documentElement.lang = context.locale;
    },
    async action(value: import("../sdk/hooks").ArtifactAction) {
      const { actions } = this.capabilities();
      if (value.type === "openUrl") {
        if (!actions.openUrl) throw new Error("Opening links is unavailable in this chat");
        const url = new URL(value.url);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS links can be opened from this artifact.");
        return app.openLink({ url: url.href });
      }
      if (value.type === "promptAgent") {
        if (!actions.promptAgent) throw new Error("Sending messages is unavailable in this chat");
        return app.sendMessage({ role: "user", content: [{ type: "text", text: value.prompt }] });
      }
      if (!extensions.files) throw new Error(`Opening local files is unavailable in this chat: ${value.path}`);
      await extensions.files.open(value.path);
      return {};
    },
    async updateContext(params: Parameters<App["updateModelContext"]>[0]) {
      if (!this.capabilities().modelContext) throw new Error("Model context is unavailable in this chat");
      if (extensions.modelContext) return extensions.modelContext.update(params);
      await app.updateModelContext(params);
      return undefined;
    },
  };
}
