import { encodeMessage, parseMessages, type JsonRpcRequest } from "./mcpProtocol";
import { handleMcpRequest } from "./mcp";
import { CanvasService } from "./service";

export async function runMcpServer(service: CanvasService): Promise<void> {
  let buffer: Buffer = Buffer.alloc(0);
  const stdin = Bun.stdin.stream();
  const reader = stdin.getReader();

  const write = async (message: object) => {
    const bytes = encodeMessage(message);
    await Bun.write(Bun.stdout, bytes);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    const parsed = parseMessages(buffer);
    buffer = parsed.rest;
    for (const request of parsed.messages as JsonRpcRequest[]) {
      const response = await handleMcpRequest(request, service);
      if (response) {
        await write(response);
      }
    }
  }
}
