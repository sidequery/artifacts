import { expect, test } from "bun:test";

import { handleMcpRequest } from "./local-tools";
import { encodeMessage, parseMessages } from "./protocol";
import { ArtifactService } from "../service";
import { VALID_ARTIFACT, tempDir } from "../test/fixtures";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ArtifactHistory } from "../history";
import { ARTIFACTS_GUIDE_EXPORTS, LEGACY_GUIDE_EXPORTS } from "./guide";
import * as sdk from "../sdk";

test("guide documents exactly the installed SDK runtime exports", () => {
  expect([...ARTIFACTS_GUIDE_EXPORTS, ...LEGACY_GUIDE_EXPORTS].sort()).toEqual(Object.keys(sdk).sort());
});

test("encodeMessage writes standard newline-delimited MCP JSON-RPC", () => {
  const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  expect(encoded.toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const { messages, rest } = parseMessages(encoded);
  expect(rest.length).toBe(0);
  expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("parseMessages retains legacy Content-Length input compatibility", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  expect(parseMessages(framed).messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("parseMessages reads newline-delimited JSON-RPC", () => {
  const { messages } = parseMessages(Buffer.from(`{"jsonrpc":"2.0","id":2,"method":"ping"}\n`, "utf8"));
  expect(messages[0]?.id).toBe(2);
});

test("MCP initialize and tools/list", async () => {
  const service = new ArtifactService({ artifactsDir: tempDir() });
  const initialized = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, service);
  expect(initialized?.result).toMatchObject({
    serverInfo: { name: "artifacts" },
  });
  const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, service);
  const tools = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  expect(tools).toContain("artifact_write");
  expect(tools).toContain("artifact_guide");
  expect(tools).toContain("artifact_read");
  expect(tools).toContain("artifact_edit");
  expect(tools).toContain("artifact_open");
  expect(tools).toContain("artifact_history");
  expect(tools).toContain("artifact_version");
  expect(tools).toContain("artifact_restore");
});

test("MCP guide is read-only", async () => {
  const dir = tempDir();
  const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: join(dir, "history.sqlite") } });
  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "artifact_guide", arguments: {} } }, service);
  const guide = response?.result as { content: Array<{ text: string }>; isError: boolean };
  expect(guide.isError).toBe(false);
  expect(service.list()).toHaveLength(0);
  expect(guide.content[0]!.text).toContain("sidequery/artifacts");
}, { timeout: 30_000 });

test(
  "MCP artifact_write returns typecheck diagnostics",
  async () => {
    const dir = tempDir();
    const service = new ArtifactService({ artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: join(dir, "history.sqlite") } });
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "artifact_write",
          arguments: { name: "overview", contents: VALID_ARTIFACT },
        },
      },
      service,
    );
    const text = (response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Artifact TypeScript check: no errors");
    expect(service.list()).toHaveLength(1);
  },
  { timeout: 30_000 },
);

test("MCP artifact_write reports sandbox errors", async () => {
  const service = new ArtifactService({ artifactsDir: tempDir() });
  const response = await handleMcpRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "artifact_write",
        arguments: {
          name: "bad",
          contents: `import fs from "fs";\nexport default function App() { return null; }\n`,
        },
      },
    },
    service,
  );
  const payload = response?.result as { content: Array<{ text: string }>; isError?: boolean };
  expect(payload.isError).toBe(true);
  expect(payload.content[0]?.text).toContain("Artifact TypeScript check:");
});

test("MCP history tools read archived source, reopen a managed pane, and restore forward", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "history.sqlite");
  const path = join(dir, "overview.artifact.tsx");
  const archive = new ArtifactHistory(dbPath);
  const version = archive.capture({ workspace: dir, name: "overview", sourcePath: path, source: VALID_ARTIFACT, runtime: "test" });
  const eventId = archive.served(version.id, { count: 4 }, "live");
  archive.close();
  const calls: string[][] = [];
  const service = new ArtifactService({
    artifactsDir: dir, env: { ARTIFACTS_HISTORY_DB: dbPath },
    herdr: { bin: "herdr", run(args) { calls.push(args); return { status: 0, stdout: "{}", stderr: "" }; } },
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, service);
    expect(response?.error).toBeUndefined();
    const result = response?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    const output = result.content[0]!.text;
    return JSON.parse(output.slice(output.indexOf("{")));
  };
  expect((await call("artifact_history", {})).versions[0].version_id).toBe(version.id);
  expect((await call("artifact_version", { version_id: version.id })).source).toBe(VALID_ARTIFACT);
  expect((await call("artifact_open", { version_id: version.id, event_id: eventId, target: "herdr" })).ok).toBe(true);
  expect(calls[0]).toContain(`ARTIFACTS_VERSION=${version.id}`);
  expect(calls[0]).toContain(`ARTIFACTS_EVENT=${eventId}`);
  expect(calls[0]).toContain(`ARTIFACTS_HISTORY_DB=${dbPath}`);
  expect((await call("artifact_restore", { version_id: version.id })).revision).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(VALID_ARTIFACT);
  const ambiguous = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "artifact_open", arguments: { name: "overview", version_id: version.id } } }, service);
  expect(ambiguous?.error?.message).toContain("but not both");
}, { timeout: 30_000 });
