import { createContext, useContext, type ReactNode } from "react";
import { loadSourceSnapshot, type SourceSnapshot } from "./drafts";
import type { Diagnostic } from "../diagnostics";

type ToolResult = { error?: string; isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
export type MutationResult = { applied?: boolean; ok?: boolean; revision_token?: string; error?: string; check?: string; diagnostics?: Diagnostic[] };
export class GalleryToolError extends Error {
  constructor(message: string, readonly status: number, readonly result?: MutationResult) { super(message); }
}
export async function galleryTool(workspace: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const params = new URLSearchParams({ workspace });
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  const response = await fetch(`/api/tools?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
  const result = await response.json() as ToolResult;
  const text = result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
  if (!response.ok || result.isError) {
    let detail = result.structuredContent as MutationResult | undefined;
    if (!detail && text) { try { detail = JSON.parse(text); } catch {} }
    throw new GalleryToolError(result.error || text || `Request failed (${response.status})`, response.status, detail);
  }
  return result.structuredContent ?? text ?? result;
}

export type GalleryTransport = {
  tool(workspace: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  loadSource(sourceUrl: string, signal?: AbortSignal): Promise<SourceSnapshot>;
};
const httpTransport: GalleryTransport = { tool: galleryTool, loadSource: loadSourceSnapshot };
const TransportContext = createContext<GalleryTransport>(httpTransport);
export function GalleryTransportProvider({ transport, children }: { transport: GalleryTransport; children: ReactNode }) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}
export function useGalleryTransport(): GalleryTransport { return useContext(TransportContext); }
