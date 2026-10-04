import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Keep operation failures machine-readable across JSON-RPC and HTTP wrappers. */
export function toolErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const conflict = message.startsWith("Project changed since") || details.status === 409;
  const payload = {
    ok: false, error: message,
    ...(typeof details.status === "number" ? { status: details.status } : { status: conflict ? 409 : /not found/.test(message) ? 404 : 400 }),
    ...(conflict ? { conflict: true, applied: false } : {}),
    ...("applied" in details ? { applied: details.applied } : {}),
    ...(Array.isArray(details.diagnostics) ? { diagnostics: details.diagnostics } : {}),
    ...(typeof details.revision_token === "string" ? { revision_token: details.revision_token } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
