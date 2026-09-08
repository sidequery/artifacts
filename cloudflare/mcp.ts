import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ARTIFACTS_APP_URI, ARTIFACTS_RESOURCE } from "../src/mcp/app-contract";
import shell from "../dist/cloudflare/mcp-app.json";
import * as validators from "../dist/cloudflare/tool-validators.js";
import { CLOUD_MCP_TOOLS } from "./tool-contract";
import type { CloudArtifactService } from "./service";

export async function handleCloudMcp(request: Request, service: Pick<CloudArtifactService, "callTool" | "fileStorage">, parsedBody?: unknown): Promise<Response> {
  // Low-level SDK registration lets local and hosted transports share the same
  // JSON schemas, with argument validators generated from them at build time.
  const server = new Server({ name: "artifacts", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CLOUD_MCP_TOOLS }));
  const resource = service.fileStorage ? { ...ARTIFACTS_RESOURCE, _meta: { ui: { ...ARTIFACTS_RESOURCE._meta.ui,
    csp: { ...ARTIFACTS_RESOURCE._meta.ui.csp, connectDomains: [service.fileStorage.origin] },
  } } } : ARTIFACTS_RESOURCE;
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== ARTIFACTS_APP_URI) throw new McpError(ErrorCode.InvalidParams, "Unknown resource");
    return { contents: [{ ...resource, text: shell }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!Object.hasOwn(validators, params.name)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    const validate = validators[params.name as keyof typeof validators];
    const args = params.arguments ?? {};
    if (!validate(args)) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments", validate.errors);
    try { return await service.callTool(params.name, args); }
    catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request, { parsedBody }); }
  finally { await server.close(); }
}
