import { expect, test } from "bun:test";
import { readToolBody } from "./http";

test("gallery import envelopes retain the existing archive request allowance", async () => {
  const archive = { large: "x".repeat(1024 * 1024) };
  for (const mcp of [false, true]) {
    for (const tool of ["artifact_import", "script_import"]) {
      const call = { name: "artifacts_tool", arguments: { workspace: "research", tool, arguments: { new_name: "copy", archive } } };
      const body = mcp ? { jsonrpc: "2.0", method: "tools/call", params: call } : call;
      expect(await readToolBody(new Request("https://artifacts.example/", { method: "POST", body: JSON.stringify(body) }), mcp)).toEqual(body);
    }
    const call = { name: "artifacts_tool", arguments: { workspace: "research", tool: "artifact_write", arguments: { contents: archive.large } } };
    const body = mcp ? { jsonrpc: "2.0", method: "tools/call", params: call } : call;
    await expect(readToolBody(new Request("https://artifacts.example/", { method: "POST", body: JSON.stringify(body) }), mcp)).rejects.toThrow("exceeds 1 MiB");
  }
});
