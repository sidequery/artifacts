import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "artifact-local-seed", version: "1" });
const url = new URL(process.env.ARTIFACTS_MCP_URL ?? "http://127.0.0.1:4785/mcp");
url.searchParams.set("workspace", process.argv[2] ?? "default");
const example = process.argv[3] ?? "overview";
if (example !== "overview" && example !== "counter") throw new Error("Example must be overview or counter");
try {
  await client.connect(new StreamableHTTPClientTransport(url));
  const result = await client.callTool({ name: "artifact_write", arguments: {
    name: example, contents: await Bun.file(new URL(`../examples/${example}.artifact.tsx`, import.meta.url)).text(),
    ...(example === "counter" ? { server: await Bun.file(new URL("../examples/counter.artifact.server.ts", import.meta.url)).text() } : {}),
  } });
  console.log(JSON.stringify(result.content, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
