import { expect, test } from "bun:test";
import Ajv from "ajv";
import { CLOUD_MCP_TOOLS } from "../../cloudflare/tool-contract";
import { callDiscoveryTool, operationCatalog } from "./discovery";
import { toolsForClient } from "./host-contract";
import { validateToolArguments } from "./validation";

const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(CLOUD_MCP_TOOLS.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));

test("every hosted operation can be inspected through the stable nine-tool surface", async () => {
  const before = toolsForClient(CLOUD_MCP_TOOLS, false);
  expect(before.map(tool => tool.name).sort()).toEqual([
    "artifact_edit", "artifact_guide", "artifact_list", "artifact_open", "artifact_read", "artifact_write",
    "artifacts_discover", "artifacts_execute", "artifacts_query",
  ]);
  const catalog = operationCatalog(CLOUD_MCP_TOOLS);
  expect(catalog).toHaveLength(48);
  const noExecution = async () => { throw new Error("Discovery without docs must not execute anything"); };
  const listing = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_discover", { limit: 50 }, noExecution);
  expect(listing.structuredContent).toMatchObject({ total: 48, next_offset: null });
  for (const operation of catalog) {
    const result = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_discover", { operation: operation.name, include_docs: false }, noExecution);
    expect(result.structuredContent).toMatchObject({ operation: operation.name, inputSchema: operation.inputSchema });
    expect(["artifacts_query", "artifacts_execute"]).toContain(result.structuredContent!.dispatch as string);
  }
  expect(toolsForClient(CLOUD_MCP_TOOLS, false)).toEqual(before);
});

test("discovery ranks related operations, paginates and loads only the selected guide", async () => {
  const calls: unknown[] = [];
  const guide = async (operation: string, args: Record<string, unknown>) => {
    calls.push({ operation, args });
    return { content: [{ type: "text" as const, text: "Selected guide" }] };
  };
  const matches = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_discover", { query: "schedule a script", limit: 1 }, guide);
  expect(matches.structuredContent).toMatchObject({ operations: [{ operation: "script_schedule" }], next_offset: 1 });
  const next = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_discover", { query: "schedule a script", offset: 1, limit: 1 }, guide);
  expect(next.structuredContent!.operations).not.toEqual(matches.structuredContent!.operations);
  expect(calls).toEqual([]);
  const details = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_discover", { operation: "artifact_files" }, guide);
  expect(calls).toEqual([{ operation: "artifact_guide", args: { topic: "files" } }]);
  expect(details.structuredContent!.documentation).toMatchObject({ content: [{ text: "Selected guide" }] });
});

test("query rejects application execution, writes and mixed-operation changes before calling the service", async () => {
  const invoked: string[] = [];
  const service = async (operation: string, args: Record<string, unknown>) => {
    validateToolArguments(validators, operation, args);
    invoked.push(operation);
    return { content: [] };
  };
  const blocked = [
    { operation: "script_run", arguments: { name: "test", request: { path: "/", method: "GET" } } },
    { operation: "artifact_request", arguments: { name: "test", request: { path: "/", method: "GET" } } },
    { operation: "artifact_plugin_call", arguments: { plugin: "test", operation: "read", input: {} } },
    { operation: "artifact_open", arguments: { name: "test" } },
    { operation: "artifact_compile", arguments: { name: "test" } },
    { operation: "app_write", arguments: { name: "test", source: "source", manifest: {} } },
    ...["artifact_schedule", "script_schedule"].flatMap(operation => ["set", "pause", "resume", "run_now"].map(action => ({ operation, arguments: { name: "test", action } }))),
    ...["artifact_secrets", "script_secrets", "app_secrets"].map(operation => ({ operation, arguments: { name: "test", secrets: {} } })),
    { operation: "artifact_files", arguments: { name: "test", request: { operation: "delete", id: crypto.randomUUID() } } },
    { operation: "artifact_files", arguments: { name: "test", request: { operation: "upload", name: "file", type: "text/plain", size: 0 } } },
    { operation: "script_schedule", arguments: { name: "test", action: "get", interval_seconds: 60 } },
  ];
  for (const input of blocked) {
    await expect(callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_query", input, service)).rejects.toThrow("Use artifacts_execute");
  }
  expect(invoked).toEqual([]);
  for (const input of [
    { operation: "script_schedule", arguments: { name: "test" } },
    { operation: "artifact_schedule", arguments: { name: "test", action: "get" } },
    ...["artifact_secrets", "script_secrets", "app_secrets"].map(operation => ({ operation, arguments: { name: "test" } })),
    { operation: "artifact_files", arguments: { name: "test", request: { operation: "list" } } },
    { operation: "artifact_files", arguments: { name: "test", request: { operation: "download", id: crypto.randomUUID() } } },
  ]) await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_query", input, service);
  expect(invoked).toHaveLength(7);
});

test("dispatch rejects hidden and recursive operations, validates original schemas and preserves results", async () => {
  let calls = 0;
  const original = { content: [], isError: true, structuredContent: { applied: true, revision_token: "saved", diagnostics: [{ message: "Invalid source" }] }, _meta: { artifact: { name: "preview" } } };
  const service = async (operation: string, args: Record<string, unknown>) => {
    validateToolArguments(validators, operation, args);
    calls++;
    return original;
  };
  for (const operation of ["artifacts_execute", "artifacts_query", "artifacts_discover", "artifacts_tool", "artifacts_source", "artifacts_settings_update", "constructor", "__proto__"]) {
    await expect(callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_execute", { operation, arguments: {} }, service)).rejects.toThrow("Unknown operation");
  }
  await expect(callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_execute", { operation: "script_write", arguments: { name: "test" } }, service)).rejects.toThrow("Invalid arguments");
  await expect(callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_query", { operation: "app_read", arguments: { name: "test", owner: "someone-else" } }, service)).rejects.toThrow("Invalid arguments");
  expect(calls).toBe(0);
  const result = await callDiscoveryTool(CLOUD_MCP_TOOLS, "artifacts_execute", { operation: "artifact_restore", arguments: { version_id: "version" } }, service);
  expect(result).toBe(original);
});
