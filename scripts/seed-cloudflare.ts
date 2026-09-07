import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "canvas-local-seed", version: "1" });
const url = new URL("http://127.0.0.1:4785/mcp");
url.searchParams.set("workspace", process.argv[2] ?? "default");
try {
  await client.connect(new StreamableHTTPClientTransport(url));
  const result = await client.callTool({ name: "canvas_write", arguments: {
    name: "overview", contents: await Bun.file(new URL("../examples/overview.canvas.tsx", import.meta.url)).text(),
  } });
  console.log(JSON.stringify(result.content, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
