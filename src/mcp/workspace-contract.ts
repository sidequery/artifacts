import { ARTIFACTS_APP_URI } from "./app-contract";
import type { GalleryData } from "../gallery/types";

export type ArtifactWorkspaceItem = {
  name: string;
  workspace: string;
  working: boolean;
  kind?: "artifact" | "script";
  versions: Array<{ id: string; revision: number; createdAt: string; reason?: string; serveCount?: number }>;
};
export type ArtifactWorkspacePayload = {
  view: "library" | "working";
  workspace: string;
  items: ArtifactWorkspaceItem[];
  nextOffset: number | null;
  gallery?: GalleryData;
  productUrl?: string;
};

const ui = { resourceUri: ARTIFACTS_APP_URI, visibility: ["app"] };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const emptySchema = { type: "object", properties: {}, additionalProperties: false };

/** Entrypoints never mutate the library and accept the host's empty arguments. */
export const ARTIFACTS_WORKSPACE_TOOLS = [
  {
    name: "artifacts_library", title: "Artifacts", description: "Browse accessible artifacts, scripts and their saved versions.",
    annotations: readOnly,
    _meta: { ui, "openai/ui": { entrypoints: [{ type: "global" }] } },
    inputSchema: emptySchema,
  },
  {
    name: "artifacts_working", title: "Working artifacts", description: "Open the conversation's artifact working view.",
    annotations: readOnly,
    _meta: { ui, "openai/ui": { entrypoints: [{ type: "thread" }] } },
    inputSchema: emptySchema,
  },
  {
    name: "artifacts_search", description: "Browse accessible artifact and script projects. Used by the library UI for filtering and pagination.",
    annotations: readOnly, _meta: { ui: { visibility: ["app"] } },
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0 }, view: { type: "string", enum: ["library", "working"] } }, additionalProperties: false },
  },
  {
    name: "artifacts_source", description: "Read the complete authorized artifact or script project for the editor, including client, server, helper files, dependencies and revision token. Never executes source.",
    annotations: readOnly, _meta: { ui: { visibility: ["app"] } },
    inputSchema: { type: "object", properties: { workspace: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["artifact", "script"] }, name: { type: "string", minLength: 1 }, version_id: { type: "string", minLength: 1 } }, required: ["workspace", "kind"], oneOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
  },
  {
    name: "artifacts_preview", description: "Open an accessible React artifact revision in the working view. Does not change source or live data.",
    annotations: readOnly, _meta: { ui },
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1 }, workspace: { type: "string", minLength: 1 }, version_id: { type: "string", minLength: 1 } }, oneOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
  },
  {
    name: "artifacts_mentions", description: "Search accessible artifact and script projects for composer mentions.",
    annotations: readOnly,
    _meta: { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": {} } },
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 } }, required: ["query"], additionalProperties: false },
  },
];

export function artifactResourceUri(item: Pick<ArtifactWorkspaceItem, "workspace" | "name" | "kind">, versionId?: string): string {
  const query = new URLSearchParams({ workspace: item.workspace, kind: item.kind ?? "artifact", name: item.name });
  if (versionId) query.set("version_id", versionId);
  return `artifact://project?${query}`;
}

/** Resource identity is descriptive; every read must repeat service authorization. */
export function parseArtifactResourceUri(uri: string) {
  const url = new URL(uri);
  const allowed = new Set(["workspace", "kind", "name", "version_id"]);
  if (url.protocol !== "artifact:" || url.hostname !== "project" || url.pathname || url.hash
    || [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw new Error("unknown artifact resource");
  const workspace = url.searchParams.get("workspace");
  const name = url.searchParams.get("name");
  const kind = url.searchParams.get("kind") ?? "artifact";
  if (!workspace || !name || (kind !== "artifact" && kind !== "script")) throw new Error("invalid artifact resource");
  const version_id = url.searchParams.get("version_id");
  if (version_id === "") throw new Error("invalid artifact version");
  return { workspace, kind, name, ...(version_id ? { version_id } : {}) } as { workspace: string; kind: "artifact" | "script"; name: string; version_id?: string };
}

export function workspaceResult(payload: ArtifactWorkspacePayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ workspace: payload.workspace, artifacts: payload.items, next_offset: payload.nextOffset }) }],
    structuredContent: { workspace: payload.workspace, artifacts: payload.items, next_offset: payload.nextOffset },
    _meta: { workspace: payload },
  };
}
