import { ARTIFACTS_APP_META } from "./app-contract";

export const MCP_TOOLS = [
  {
    name: "artifact_guide",
    description: "Read the Sidequery Artifacts SDK contract: exports, host APIs, component conventions, restrictions, and validation behavior. Call before creating an artifact if you have not read it in this conversation.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "artifact_read",
    description: "Read working raw TSX by inclusive 1-based line range (default 200 lines). Returns exact source with line endings, total_lines, next_line and a full-file source_hash for guarded edits. Rejects symlinks and names with slashes.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, file: { type: "string", description: "Optional existing project helper path." }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "artifact_edit",
    _meta: ARTIFACTS_APP_META,
    description: "Apply sequential exact-text replacements to a working artifact. Every non-empty old_text must match exactly once; empty new_text deletes. Optional expected_hash guards against changes since artifact_read. Invalid batches write nothing. Atomically replaces source then typechecks once; failed diagnostics leave edits applied. Returns compact summary, hash and diagnostics, not source. Rejects symlinks and names with slashes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        file: { type: "string", description: "Optional existing project helper path. Omit to edit the artifact entrypoint." },
        edits: { type: "array", minItems: 1, items: { type: "object", properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } }, required: ["old_text", "new_text"], additionalProperties: false } },
        expected_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["name", "edits"], additionalProperties: false,
    },
  },
  {
    name: "artifact_history",
    description: "List archived artifact versions in this workspace, including deleted artifacts. Optionally filter by name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "artifact_version",
    description: "Read an archived version's raw TSX, metadata, and serve events with initial-state snapshots.",
    inputSchema: { type: "object", properties: { version_id: { type: "string" } }, required: ["version_id"], additionalProperties: false },
  },
  {
    name: "artifact_remix",
    _meta: ARTIFACTS_APP_META,
    description: "Copy a working artifact or archived version to a new artifact with source provenance and fresh state. Never overwrites existing artifacts or archived identities. Supply exactly one of name and version_id, plus new_name.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, version_id: { type: "string" }, new_name: { type: "string" } },
      required: ["new_name"], oneOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
  },
  {
    name: "artifact_restore",
    _meta: ARTIFACTS_APP_META,
    description: "Replace a working artifact with archived TSX. Saves the current working source first, adds a new revision, and preserves later history and current UI state. Returns typecheck diagnostics after restoration.",
    inputSchema: { type: "object", properties: { version_id: { type: "string" } }, required: ["version_id"], additionalProperties: false },
  },
  {
    name: "artifact_list",
    description: "List .artifact.tsx files in the artifacts directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "artifact_write",
    _meta: ARTIFACTS_APP_META,
    description:
      "Create or replace an artifact and display it inline in chat after typechecking. Before creating an artifact, call artifact_guide if you have not read it in this conversation. Import from sidequery/artifacts. Pass kebab-case name without slashes. Returns Artifact TypeScript check diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Artifact name, e.g. billing-review or billing-review.artifact.tsx" },
        project: { type: "object", properties: { files: { type: "object", additionalProperties: { type: "string" } }, dependencies: { type: "object", additionalProperties: { type: "string" } } }, additionalProperties: false, description: "Helper modules by relative path and bun packages pinned to exact versions. Omit to preserve existing project. Resolved package snapshot is retained for replay." },
        contents: { type: "string", description: "Full .artifact.tsx source" },
        open: { type: "boolean", description: "Legacy flag; successful writes now always show the artifact inline." },
        target: { type: "string", enum: ["inline", "herdr"], default: "inline", description: "Use herdr only to explicitly open a terminal pane as well." },
      },
      required: ["name", "contents"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_typecheck",
    description: "Typecheck and sandbox-scan an artifact file.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_compile",
    description: "Sandbox-scan and bundle an artifact file with Bun.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_open",
    _meta: ARTIFACTS_APP_META,
    description: "Show the interactive artifact inline in chat. Supply name for a working artifact, or version_id for an archived artifact. Optional event_id selects archived initial state. Use target: herdr only to explicitly open a terminal pane instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version_id: { type: "string" },
        event_id: { type: "string" },
        target: { type: "string", enum: ["inline", "herdr"], default: "inline" },
        placement: { type: "string", enum: ["split", "tab", "zoomed", "overlay"] },
      },
      oneOf: [{ required: ["name"] }, { required: ["version_id"] }],
      additionalProperties: false,
    },
  },
] as const;
