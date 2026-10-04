import { ARTIFACTS_APP_URI } from "./app-contract";

export type ArtifactWorkspaceItem = {
  name: string;
  workspace: string;
  working: boolean;
  versions: Array<{ id: string; revision: number; createdAt: string }>;
};
export type ArtifactWorkspacePayload = {
  view: "library" | "working";
  workspace: string;
  items: ArtifactWorkspaceItem[];
  nextOffset: number | null;
};

const ui = { resourceUri: ARTIFACTS_APP_URI, visibility: ["app"] };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const emptySchema = { type: "object", properties: {}, additionalProperties: false };

/** Entrypoints never mutate the library and accept the host's empty arguments. */
export const ARTIFACTS_WORKSPACE_TOOLS = [
  {
    name: "artifacts_library", title: "Artifacts", description: "Browse accessible React artifacts and their saved versions.",
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
    name: "artifacts_search", description: "Browse accessible artifacts. Used by the library UI for filtering and pagination.",
    annotations: readOnly, _meta: { ui: { visibility: ["app"] } },
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0 }, view: { type: "string", enum: ["library", "working"] } }, additionalProperties: false },
  },
  {
    name: "artifacts_preview", description: "Open an accessible React artifact revision in the working view. Does not change source or live data.",
    annotations: readOnly, _meta: { ui },
    inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1 }, workspace: { type: "string", minLength: 1 }, version_id: { type: "string", minLength: 1 } }, oneOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
  },
  {
    name: "artifacts_mentions", description: "Search accessible artifacts for composer mentions.",
    annotations: readOnly,
    _meta: { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": {} } },
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 } }, required: ["query"], additionalProperties: false },
  },
];

export function artifactResourceUri(item: Pick<ArtifactWorkspaceItem, "workspace" | "name">, versionId?: string): string {
  const query = new URLSearchParams({ workspace: item.workspace, name: item.name });
  if (versionId) query.set("version_id", versionId);
  return `artifact://project?${query}`;
}

export function workspaceResult(payload: ArtifactWorkspacePayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ workspace: payload.workspace, artifacts: payload.items, next_offset: payload.nextOffset }) }],
    structuredContent: { workspace: payload.workspace, artifacts: payload.items, next_offset: payload.nextOffset },
    _meta: { workspace: payload },
  };
}
