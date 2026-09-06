export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function encodeMessage(message: object): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

export function parseMessages(buffer: Buffer): { messages: JsonRpcRequest[]; rest: Buffer } {
  const messages: JsonRpcRequest[] = [];
  let rest = buffer;

  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd !== -1 && rest.subarray(0, 20).toString("utf8").toLowerCase().startsWith("content-length:")) {
      const header = rest.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        break;
      }
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      if (rest.length < start + length) {
        break;
      }
      const body = rest.subarray(start, start + length).toString("utf8");
      messages.push(JSON.parse(body) as JsonRpcRequest);
      rest = rest.subarray(start + length);
      continue;
    }

    const newline = rest.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = rest.subarray(0, newline).toString("utf8").trim();
    rest = rest.subarray(newline + 1);
    if (line) {
      messages.push(JSON.parse(line) as JsonRpcRequest);
    }
  }

  return { messages, rest };
}
