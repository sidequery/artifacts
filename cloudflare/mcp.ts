import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError, type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { isArtifactAppUri, ARTIFACTS_RESOURCE } from "../src/mcp/app-contract";
import shell from "../dist/cloudflare/mcp-app.json";
import * as validators from "../dist/cloudflare/tool-validators.js";
import { artifactFileResult } from "../src/mcp/file-contract";
import { clientSupportsApps, toolsForClient } from "../src/mcp/host-contract";
import { CLOUD_MCP_TOOLS } from "./tool-contract";
import type { CloudArtifactService } from "./service";
import { parseArtifactResourceUri } from "../src/mcp/workspace-contract";
import { toolErrorResult } from "../src/mcp/tool-result";
import { ARTIFACTS_SETTINGS_CAPABILITY } from "../src/mcp/settings-contract";

export async function handleCloudMcp(request: Request, service: Pick<CloudArtifactService, "callTool" | "fileStorage" | "snapshot" | "scriptReadSource">, parsedBody?: unknown): Promise<Response> {
  // Low-level SDK registration lets local and hosted transports share the same
  // JSON schemas, with argument validators generated from them at build time.
  const server = new Server({ name: "artifacts", version: "0.1.0" }, { capabilities: { tools: {}, resources: {},
    extensions: { "openai/settings": ARTIFACTS_SETTINGS_CAPABILITY }, experimental: { "openai/settings": ARTIFACTS_SETTINGS_CAPABILITY },
  } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsForClient(CLOUD_MCP_TOOLS, server.getClientCapabilities() === undefined || clientSupportsApps(server.getClientCapabilities())) }));
  const resource = service.fileStorage ? { ...ARTIFACTS_RESOURCE, _meta: { ...ARTIFACTS_RESOURCE._meta, ui: { ...ARTIFACTS_RESOURCE._meta.ui,
    csp: { ...ARTIFACTS_RESOURCE._meta.ui.csp, connectDomains: [service.fileStorage.origin] },
  } } } : ARTIFACTS_RESOURCE;
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "artifact://project?workspace={workspace}&kind={kind}&name={name}", name: "Artifact or script project", description: "Read a complete artifact or script project in the authenticated library.", mimeType: "application/json" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri.startsWith("artifact://")) {
      const { kind, ...selection } = parseArtifactResourceUri(params.uri);
      // Admission is repeated for every read; a previously issued mention URI is
      // descriptive context, never an authorization capability.
      const snapshot = kind === "script" ? await service.scriptReadSource(selection) : await service.snapshot(selection);
      if (snapshot.name !== selection.name) throw new McpError(ErrorCode.InvalidParams, "Artifact version does not match name");
      return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify({ ...snapshot, kind, workspace: selection.workspace, description: `${kind} ${snapshot.name} in workspace ${selection.workspace}` }) }] };
    }
    if (!isArtifactAppUri(params.uri)) throw new McpError(ErrorCode.InvalidParams, "Unknown resource");
    return { contents: [{ ...resource, uri: params.uri, text: shell }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!Object.hasOwn(validators, params.name)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    const validate = validators[params.name as keyof typeof validators];
    const args = params.arguments ?? {};
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments", validate.errors);
    try {
      const result: CallToolResult = params.name === "artifacts_file" ? artifactFileResult(args) : await service.callTool(params.name, args);
      if (server.getClientCapabilities() !== undefined && !clientSupportsApps(server.getClientCapabilities())) {
        const { _meta, ...plain } = result;
        return plain;
      }
      return result;
    }
    catch (error) {
      return toolErrorResult(error);
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request, { parsedBody }); }
  finally { await server.close(); }
}
