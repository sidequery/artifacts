import { PROJECT_IMPORT_REQUEST_BYTES } from "../src/project-archive-contract";

/** Only archive imports may exceed the ordinary 1 MiB management request limit. */
export async function readToolBody(request: Request, mcp = false): Promise<unknown> {
  const text = await readRequestText(request, PROJECT_IMPORT_REQUEST_BYTES);
  const oversized = new TextEncoder().encode(text).byteLength > 1024 * 1024;
  let value: { name?: string; method?: string; params?: { name?: string } } | null;
  try { value = JSON.parse(text); }
  catch (error) { if (oversized) throw new RangeError("Request exceeds 1 MiB"); throw error; }
  const name = mcp ? value?.method === "tools/call" ? value.params?.name : undefined : value?.name;
  if (oversized && name !== "artifact_import" && name !== "script_import") throw new RangeError("Request exceeds 1 MiB");
  return value;
}

export async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RangeError("Request body is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
