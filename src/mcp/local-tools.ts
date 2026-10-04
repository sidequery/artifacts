import { ArtifactService, type ArtifactEdit, type ReadOptions } from "../service";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { artifactIdFromFile } from "../artifactFile";
import { artifactGuideResult } from "./guide";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol";
import { ARTIFACTS_APP_URI, ARTIFACTS_RESOURCE, artifactAppHtml, artifactAppResult } from "./app";

const PROTOCOL_VERSION = "2025-06-18";

export { MCP_TOOLS } from "./tools";
import { MCP_TOOLS } from "./tools";
import { parseProjectArchive } from "../project-archive";
import { ARTIFACTS_WORKSPACE_TOOLS, workspaceResult } from "./workspace-contract";
import { localWorkspace, localMentions, localResource, localSource } from "./local-workspace";
import { ARTIFACTS_FILE_TOOL, artifactFileResult } from "./file-contract";
import { clientSupportsApps, toolsForClient } from "./host-contract";
import { ARTIFACTS_SETTINGS_CAPABILITY, ARTIFACTS_SETTINGS_TOOLS, settingsTool } from "./settings-contract";

const appClients = new WeakMap<ArtifactService, boolean>();

export async function handleMcpRequest(
  request: JsonRpcRequest,
  service: ArtifactService,
): Promise<JsonRpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }

  try {
    if (request.method === "initialize") {
      const params = request.params as { capabilities?: unknown } | undefined;
      appClients.set(service, clientSupportsApps(params?.capabilities));
      return ok(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, extensions: { "openai/settings": ARTIFACTS_SETTINGS_CAPABILITY }, experimental: { "openai/settings": ARTIFACTS_SETTINGS_CAPABILITY } },
        serverInfo: { name: "artifacts", version: "0.1.0" },
      });
    }
    if (request.method === "ping") {
      return ok(request.id, {});
    }
    if (request.method === "tools/list") {
      return ok(request.id, { tools: toolsForClient([...MCP_TOOLS, ...ARTIFACTS_WORKSPACE_TOOLS, ARTIFACTS_FILE_TOOL, ...ARTIFACTS_SETTINGS_TOOLS], appClients.get(service) ?? true) });
    }
    if (request.method === "resources/list") return ok(request.id, { resources: [ARTIFACTS_RESOURCE] });
    if (request.method === "resources/templates/list") return ok(request.id, { resourceTemplates: [] });
    if (request.method === "resources/read") {
      const params = request.params as { uri?: string } | undefined;
      if (params?.uri?.startsWith("artifact:")) return ok(request.id, { contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(localResource(service, params.uri)) }] });
      if (params?.uri !== ARTIFACTS_APP_URI) return error(request.id, -32002, "unknown resource");
      return ok(request.id, { contents: [{ ...ARTIFACTS_RESOURCE, text: await artifactAppHtml() }] });
    }
    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const apps = appClients.get(service) ?? true;
      if (!apps && [...ARTIFACTS_WORKSPACE_TOOLS, ARTIFACTS_FILE_TOOL].some(tool => tool.name === params.name)) throw new Error("MCP Apps support is required for this tool");
      const result = await callTool(service, params.name ?? "", params.arguments ?? {});
      if (!apps) { const { _meta, ...textResult } = result; return ok(request.id, textResult); }
      return ok(request.id, result);
    }
    return error(request.id, -32601, `unknown method: ${request.method}`);
  } catch (err) {
    return error(request.id, -32000, err instanceof Error ? err.message : String(err));
  }
}

async function callTool(
  service: ArtifactService,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (name === "artifacts_file") return artifactFileResult(args);
  if (ARTIFACTS_SETTINGS_TOOLS.some(tool => tool.name === name)) return settingsTool({ workspace: service.artifactsDir, async gallery() { return localWorkspace(service, "library").gallery!; } }, name, args);
  if (name === "artifacts_source") {
    const payload = localSource(service, args);
    return { ...text(JSON.stringify(payload)), structuredContent: payload };
  }
  if (name === "artifacts_library" || name === "artifacts_working" || name === "artifacts_search") {
    const view = name === "artifacts_working" || args.view === "working" ? "working" : "library";
    return workspaceResult(localWorkspace(service, view, args.query as string | undefined, args.offset as number | undefined));
  }
  if (name === "artifacts_mentions") {
    const items = localMentions(service, args.query as string);
    return { ...text(JSON.stringify({ items })), structuredContent: { items } };
  }
  if (name === "artifacts_preview") {
    if (args.workspace !== undefined && args.workspace !== service.artifactsDir) throw new Error("artifact is outside this workspace");
    return previewResult(await artifactAppResult(service, args as { name?: string; version_id?: string }));
  }
  const deliver = args.preview !== false && (appClients.get(service) ?? true);
  if (args.preview !== undefined && typeof args.preview !== "boolean") throw new Error("preview must be a boolean");
  if (name === "artifact_guide") return artifactGuideResult();
  if (name === "artifact_export") return text(JSON.stringify(service.exportProject({ name: args.name as string | undefined, version_id: args.version_id as string | undefined })));
  if (name === "artifact_import") {
    const archive = parseProjectArchive(args.archive, "artifact");
    const result = service.importProject(args.new_name as string, archive);
    return withPreview(service, result, { name: result.name }, deliver);
  }
  if (name === "artifact_read" || name === "artifact_edit") {
    if (typeof args.name !== "string") throw new Error("artifact name must be a string");
    if (name === "artifact_read") {
      return text(JSON.stringify(service.readRange(args.name, { file: args.file, start_line: args.start_line, end_line: args.end_line } as ReadOptions)));
    }
    const result = service.edit(args.name, args.edits as ArtifactEdit[], args.expected_hash as string | undefined, args.file as string | undefined);
    return withPreview(service, result, { name: args.name }, deliver);
  }
  if (name === "artifact_history") return text(JSON.stringify({ versions: service.history(args.name === undefined ? undefined : String(args.name)) }, null, 2));
  if (name === "artifact_version") return text(JSON.stringify(service.version(String(args.version_id)), null, 2));
  if (name === "artifact_remix") {
    const result = service.remix(args as Parameters<ArtifactService["remix"]>[0]);
    return withPreview(service, result, { name: result.name }, deliver);
  }
  if (name === "artifact_restore") {
    const result = service.restore(String(args.version_id));
    return withPreview(service, result, { name: artifactIdFromFile(result.path) }, deliver);
  }
  if (name === "artifact_list") {
    return text(JSON.stringify({ artifacts: service.list() }, null, 2));
  }
  if (name === "artifact_write") {
    if (args.target !== undefined && args.target !== "inline" && args.target !== "herdr") throw new Error("target must be inline or herdr");
    const written = args.project === undefined ? service.write(String(args.name), String(args.contents ?? "")) : await service.writeProject(String(args.name), String(args.contents ?? ""), args.project);
    let opened: unknown;
    if (args.target === "herdr" && written.ok) {
      opened = await service.open(written.path);
    }
    const payload = { ...written, opened };
    return withPreview(service, payload, { name: String(args.name) }, deliver);
  }
  if (name === "artifact_typecheck") {
    const result = service.typecheck(String(args.name));
    return text(`${result.check}\n\n${JSON.stringify(result, null, 2)}`, result.diagnostics.length > 0);
  }
  if (name === "artifact_compile") {
    const result = await service.compile(String(args.name));
    return text(
      `${result.check}\n\n${JSON.stringify({ ok: result.ok, path: result.path, bytes: result.js?.length ?? 0 }, null, 2)}`,
      !result.ok,
    );
  }
  if (name === "artifact_open") {
    if (Boolean(args.name) === Boolean(args.version_id)) throw new Error("provide name or version_id, but not both");
    if (args.target !== undefined && args.target !== "inline" && args.target !== "herdr") throw new Error("target must be inline or herdr");
    if (args.target !== "herdr") {
      const result = await artifactAppResult(service, args as { name?: string; version_id?: string; event_id?: string });
      return previewResult(result);
    }
    const result = await service.open(args.name === undefined ? "" : String(args.name), {
      versionId: args.version_id === undefined ? undefined : String(args.version_id),
      eventId: args.event_id === undefined ? undefined : String(args.event_id),
      placement: args.placement as "split" | "tab" | "zoomed" | "overlay" | undefined,
    });
    return text(`${result.check}\n\n${JSON.stringify(result, null, 2)}`, !result.ok);
  }
  throw new Error(`unknown tool: ${name}`);
}

function previewResult(result: Awaited<ReturnType<typeof artifactAppResult>>) {
  const { _meta, ...payload } = result;
  return { ...text(`${result.check}\n\n${JSON.stringify(payload, null, 2)}`, !result.ok), structuredContent: payload, ...(_meta ? { _meta } : {}) };
}

async function withPreview(service: ArtifactService, result: { ok: boolean; check: string; [key: string]: unknown }, selection: { name: string }, deliver = true) {
  if (!result.ok) return { ...text(JSON.stringify(result, null, 2), true), structuredContent: result };
  // Write/edit/restore have already applied. Preview failure must not imply rollback.
  try {
    const preview = await artifactAppResult(service, selection, deliver);
    const { _meta, ...details } = preview;
    const payload = { ...result, preview: details };
    return { ...text(JSON.stringify(preview.ok ? result : payload, null, 2), !preview.ok), structuredContent: payload, ...(_meta ? { _meta } : {}) };
  } catch (error) {
    const payload = { ...result, preview: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    return { ...text(JSON.stringify(payload), true), structuredContent: payload };
  }
}

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], isError };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
