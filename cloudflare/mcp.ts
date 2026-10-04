import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError, type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ARTIFACTS_APP_URI, ARTIFACTS_RESOURCE } from "../src/mcp/app-contract";
import shell from "../dist/cloudflare/mcp-app.json";
import * as validators from "../dist/cloudflare/tool-validators.js";
import { artifactFileResult } from "../src/mcp/file-contract";
import { clientSupportsApps, toolsForClient } from "../src/mcp/host-contract";
import { CLOUD_MCP_TOOLS } from "./tool-contract";
import type { CloudArtifactService } from "./service";

export async function handleCloudMcp(request: Request, service: Pick<CloudArtifactService, "callTool" | "fileStorage" | "snapshot">, parsedBody?: unknown): Promise<Response> {
  // Low-level SDK registration lets local and hosted transports share the same
  // JSON schemas, with argument validators generated from them at build time.
  const server = new Server({ name: "artifacts", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsForClient(CLOUD_MCP_TOOLS, server.getClientCapabilities() === undefined || clientSupportsApps(server.getClientCapabilities())) }));
  const resource = service.fileStorage ? { ...ARTIFACTS_RESOURCE, _meta: { ...ARTIFACTS_RESOURCE._meta, ui: { ...ARTIFACTS_RESOURCE._meta.ui,
    csp: { ...ARTIFACTS_RESOURCE._meta.ui.csp, connectDomains: [service.fileStorage.origin] },
  } } } : ARTIFACTS_RESOURCE;
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "artifact://project?workspace={workspace}&name={name}", name: "Artifact source", description: "Read an artifact source snapshot in the authenticated library.", mimeType: "application/json" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri.startsWith("artifact://")) {
      const uri = new URL(params.uri);
      if (uri.hostname !== "project" || uri.pathname || !uri.searchParams.get("workspace") || !uri.searchParams.get("name")) throw new McpError(ErrorCode.InvalidParams, "Invalid artifact resource");
      // Admission is repeated for every read; a previously issued mention URI is
      // descriptive context, never an authorization capability.
      const selection = { workspace: uri.searchParams.get("workspace")!, name: uri.searchParams.get("name")!, ...(uri.searchParams.has("version_id") ? { version_id: uri.searchParams.get("version_id")! } : {}) };
      const snapshot = await service.snapshot(selection);
      if (snapshot.name !== selection.name) throw new McpError(ErrorCode.InvalidParams, "Artifact version does not match name");
      return { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify({ name: snapshot.name, workspace: snapshot.workspace, version_id: snapshot.version_id ?? null, revision_token: snapshot.revision_token, description: `React artifact ${snapshot.name} in workspace ${snapshot.workspace}`, source: snapshot.source, server_source: snapshot.server_source, project: snapshot.project }) }] };
    }
    if (params.uri !== ARTIFACTS_APP_URI) throw new McpError(ErrorCode.InvalidParams, "Unknown resource");
    return { contents: [{ ...resource, text: shell }] };
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
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request, { parsedBody }); }
  finally { await server.close(); }
}
