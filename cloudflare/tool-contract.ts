import { ARTIFACTS_FILE_TOOL } from "../src/mcp/file-contract";
import { applyToolVisibility } from "../src/mcp/host-contract";
import { ARTIFACTS_WORKSPACE_TOOLS } from "../src/mcp/workspace-contract";
import { galleryToolDefinition } from "../src/mcp/gallery-contract";
import { ARTIFACTS_SETTINGS_TOOLS } from "../src/mcp/settings-contract";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS } from "../src/mcp/tools";
import { PROJECT_ARCHIVE_SCHEMA } from "../src/project-archive-contract";

// Share the local tool contract. A hosted service cannot open a terminal pane.
export const CLOUD_MCP_TOOLS: Tool[] = JSON.parse(JSON.stringify(MCP_TOOLS));
for (const tool of CLOUD_MCP_TOOLS) {
  tool.description = tool.description?.replaceAll(" Rejects symlinks and names with slashes.", " Rejects names with slashes.")
    .replace("Sandbox-scan and bundle an artifact file with Bun.", "Typecheck, sandbox-scan and compile an artifact for the browser.")
    .replace("List .artifact.tsx files in the artifacts directory.", "List working artifacts in this workspace.")
    .replace(" Use target: herdr only to explicitly open a terminal pane instead.", "");
  if (tool.inputSchema.properties?.target) {
    tool.inputSchema.properties.target = { type: "string", enum: ["inline"], default: "inline", description: "Hosted artifacts open inline in the MCP App viewer." };
    delete tool.inputSchema.properties.placement;
  }
  if (tool.name === "artifact_list" || tool.name === "artifact_history" || tool.name === "artifact_version") {
    const field = tool.name === "artifact_version" ? "events_offset" : "offset";
    tool.inputSchema.properties = { ...tool.inputSchema.properties, [field]: { type: "integer", minimum: 0, default: 0 } };
    tool.description += tool.name === "artifact_version"
      ? " Serve events are paginated, 20 per response; pass next_events_offset as events_offset for older events."
      : " Results are paginated, 100 per response; pass next_offset as offset for the next page.";
  }
  if (tool.name === "artifact_write") {
    tool.inputSchema.properties = { ...tool.inputSchema.properties,
      server: { type: ["string", "null"], description: "Optional native server TypeScript exporting class ArtifactServer extends DurableObject from cloudflare:workers. Use this.ctx.storage.sql for native SQLite and this.ctx.storage.kv for key/value storage. Omit to preserve; null removes server code without deleting its database." },
    };
  }
  if (tool.name === "artifact_read" || tool.name === "artifact_edit") {
    tool.inputSchema.properties = { ...tool.inputSchema.properties,
      part: { type: "string", enum: ["client", "server"], default: "client", description: "Select browser TSX or native server TypeScript." },
    };
  }
  if (tool.name === "artifact_compile") {
    tool.description = "Compile and durably save the client/server bundle for a working artifact or an archived revision. Select name or version_id. Use this to prepare source-only revisions from older installations; reads never compile. Already compiled archived revisions keep their original bundle.";
    tool.inputSchema.properties = { name: { type: "string" }, version_id: { type: "string" } };
    delete tool.inputSchema.required;
    tool.inputSchema.oneOf = [{ required: ["name"] }, { required: ["version_id"] }];
  }
}

export const ARTIFACTS_REQUEST_SCHEMA = {
  type: "object", properties: {
    path: { type: "string", minLength: 1, maxLength: 8192 },
    method: { type: "string", default: "GET" },
    headers: { type: "array", maxItems: 100, items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } },
    body: { type: "string", maxLength: 349528, description: "Base64-encoded request body, maximum 256 KiB decoded." },
  }, required: ["path"], additionalProperties: false,
};
CLOUD_MCP_TOOLS.push({
  name: "artifact_request",
  description: "Send an HTTP request to an artifact's native server. Its fetch handler can use native Durable Object SQLite/KV APIs. Select name or version_id. Database contents remain live across source edits and restores. Returns a response envelope with base64 body; artifactFetch provides ordinary Request/Response behavior in the UI.",
  inputSchema: { type: "object", properties: {
    name: { type: "string" }, version_id: { type: "string" }, request: ARTIFACTS_REQUEST_SCHEMA,
  }, required: ["request"], anyOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
});

export const ARTIFACTS_FILE_REQUEST_SCHEMA = {
  oneOf: [
    { type: "object", properties: { operation: { const: "list" }, cursor: { type: "string", maxLength: 2048 } }, required: ["operation"], additionalProperties: false },
    { type: "object", properties: { operation: { const: "upload" }, name: { type: "string", minLength: 1, maxLength: 255 }, size: { type: "integer", minimum: 0, maximum: 26214400 }, type: { type: "string", maxLength: 255 } }, required: ["operation", "name", "size", "type"], additionalProperties: false },
    { type: "object", properties: { operation: { enum: ["download", "delete"] }, id: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } }, required: ["operation", "id"], additionalProperties: false },
  ],
};
CLOUD_MCP_TOOLS.push({
  name: "artifact_files",
  description: "Manage files belonging to one artifact. List returns up to 100 files and an optional cursor. Upload allocates a new file and a single-use PUT URL (5 minutes, exact declared size, maximum 25 MiB); send raw bytes to that URL, never through this tool. Download returns a GET URL valid for 5 minutes. Delete removes a file. Files remain live across source edits and restores. Requires an existing artifact; no server code needed. Transfer URLs are bearer capabilities: do not publish them.",
  inputSchema: { type: "object", properties: { name: { type: "string" }, version_id: { type: "string" }, request: ARTIFACTS_FILE_REQUEST_SCHEMA }, required: ["request"], anyOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
});

const slugProperties = {
  slug: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$", description: "Chosen root URL slug, unique across this deployment." },
  access: { type: "string", enum: ["private", "public"], description: "Private uses library permissions; public allows external HTTP callers. Default private." },
};
for (const kind of ["artifact", "script"]) {
  // Artifact is shared with local MCP; hosted script authoring uses this contract too.
  if (!CLOUD_MCP_TOOLS.some(tool => tool.name === kind + "_remix")) CLOUD_MCP_TOOLS.push({name:kind + "_remix",description:"Copy a working artifact or immutable revision to a new name in this workspace. Preserves source provenance. Starts with fresh state, storage, and secrets and a private URL. Never overwrites an existing artifact.",inputSchema:{type:"object",properties:{name:{type:"string",minLength:1},version_id:{type:"string",minLength:1},new_name:{type:"string",minLength:1},slug:slugProperties.slug},required:["new_name"],oneOf:[{required:["name"]},{required:["version_id"]}],additionalProperties:false}});
  else Object.assign(CLOUD_MCP_TOOLS.find(tool => tool.name === kind + "_remix")!.inputSchema.properties!, {slug:slugProperties.slug});
}
const artifactWrite = CLOUD_MCP_TOOLS.find(tool => tool.name === "artifact_write")!;
Object.assign(artifactWrite.inputSchema.properties!, slugProperties);
Object.assign(CLOUD_MCP_TOOLS.find(tool => tool.name === "artifact_import")!.inputSchema.properties!, { slug: slugProperties.slug });
CLOUD_MCP_TOOLS.push(
  { name: "script_export", description: "Export script source, helpers and exact dependency snapshot as a complete versioned project archive. Includes no secrets, database or schedules.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { name: { type: "string" }, version_id: { type: "string" } }, oneOf: [{ required: ["name"] }, { required: ["version_id"] }], additionalProperties: false } },
  { name: "script_import", description: "Import a complete script project archive under a fresh new_name and private URL. Preserves dependency bytes without network resolution. Copies no secrets, storage or schedules; invalid code stays as a draft with diagnostics.", inputSchema: { type: "object", properties: { new_name: { type: "string" }, slug: slugProperties.slug, archive: PROJECT_ARCHIVE_SCHEMA }, required: ["new_name", "archive"], additionalProperties: false } },
);
function addScriptTool(name: string, description: string, properties: Record<string, object>, required: string[] = []) {
  CLOUD_MCP_TOOLS.push({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
}
const nameProperty = { name: { type: "string", minLength: 1, description: "Script name in this workspace." } };
const pageProperty = { offset: { type: "integer", minimum: 0, default: 0 } };
addScriptTool("artifact_link", "Give an artifact or script a chosen root URL. Artifact links require valid source and work independently of the gallery. Defaults to private access. Renaming a slug changes its URL.", {
  kind: { type: "string", enum: ["artifact", "script"] }, name: { type: "string", minLength: 1 }, ...slugProperties,
}, ["kind", "name", "slug"]);
addScriptTool("script_guide", "Read the hosted script and root-URL authoring guide before creating a script. Covers runtime, access, storage, secrets, validation, HTTP requests, and bundling third-party dependencies.", {});
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: true };
addScriptTool("script_write", "Call script_guide first. Create or replace arbitrary Workers-compatible TypeScript exporting default { fetch(request, env, ctx) }. Saved drafts and history are retained even when validation fails; only valid updates replace the running code. Scripts have outbound fetch, env.secrets, and env.sql for persistent SQLite. Slug defaults to the name; URLs use /<slug>. Use project.files for relative modules and project.dependencies for exact package versions. Dependencies are resolved and integrity-verified at write time, then archived as a source lock; execution and replay do not install packages. This loads the module for validation but does not execute the handler.", {
  ...nameProperty, contents: { type: "string", maxLength: 262144 }, ...slugProperties,
}, ["name", "contents"]);
addScriptTool("script_read", "Read script source with bounded line ranges, optionally from a historical version. Does not execute the script.", {
  ...nameProperty, version_id: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
}, ["name"]);
addScriptTool("script_edit", "Apply ordered, uniquely matching text replacements atomically, validate, and update the same URL on success. Invalid drafts retain the last working handler.", {
  ...nameProperty, edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } }, required: ["old_text", "new_text"], additionalProperties: false } }, expected_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
}, ["name", "edits"]);
addScriptTool("script_list", "List saved scripts and their URLs without running them. Paginated, 100 per response.", pageProperty);
addScriptTool("script_run", "Execute a script's last validated handler. request.path is passed unchanged at the deployment origin; include the slug to reproduce a direct URL request. Returns HTTP response headers, status, and base64 body (maximum 256 KiB); use its URL for streaming or larger responses. May perform arbitrary script-defined writes or outbound requests.", { ...nameProperty, request: ARTIFACTS_REQUEST_SCHEMA }, ["name", "request"]);
addScriptTool("script_history", "List script source history, 100 entries per page.", { ...nameProperty, ...pageProperty });
addScriptTool("script_version", "Read an immutable script source revision. Never returns secrets.", { version_id: { type: "string" } }, ["version_id"]);
addScriptTool("script_restore", "Restore a script revision as a new draft and activate it if validation succeeds. Persistent storage remains live.", { ...nameProperty, version_id: { type: "string" } }, ["name", "version_id"]);
addScriptTool("script_schedule", "Inspect or configure recurring execution of the latest validated script. Use action set with exactly one of interval_seconds or five-field cron (timezone defaults UTC) and an optional request. Pause/resume preserve settings; run_now explicitly invokes the saved request, including while paused. Failed or interrupted runs are never automatically replayed; missed occurrences are skipped.", {...nameProperty,action:{type:"string",enum:["get","set","pause","resume","run_now"]},interval_seconds:{type:"integer",minimum:60,maximum:31536000},cron:{type:"string",maxLength:256},timezone:{type:"string",maxLength:100},request:ARTIFACTS_REQUEST_SCHEMA},["name"]);
addScriptTool("script_runs", "Inspect recent invocation outcomes, revision hashes, triggers, and HTTP-handler durations. Retains 1000 runs, returns the latest 100. Interrupted means completion is unknown; background waitUntil work and streamed response completion are not part of HTTP-handler success.", {...nameProperty,limit:{type:"integer",minimum:1,maximum:100}},["name"]);
addScriptTool("script_logs", "Read bounded recent execution logs and errors without executing the script. Optionally filter by run_id from script_runs.", { ...nameProperty, run_id:{type:"string"}, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["name"]);
addScriptTool("script_secrets", "Set or delete per-script secrets (null deletes). Omit secrets to list names. Values are never returned or added to source history.", { ...nameProperty, secrets: { type: "object", maxProperties: 32, additionalProperties: { type: ["string", "null"], maxLength: 4096 } } }, ["name"]);
addScriptTool("artifact_secrets", "Set or delete per-artifact backend secrets (null deletes). Omit secrets to list names. Values are available as this.env.secrets in ArtifactServer, never returned or added to source history. Edits and restores preserve secrets; remixes and imports start empty.", { ...nameProperty, secrets: { type: "object", maxProperties: 32, additionalProperties: { type: ["string", "null"], maxLength: 4096 } } }, ["name"]);

addScriptTool("plugins_list", "List deployment-installed plugins, browser availability, and operation schemas and read-only hints. Does not execute operations.", {});
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: true };
addScriptTool("plugin_guide", "Read the authenticated deployment plugin calling and authoring guide.", {});
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: true };
addScriptTool("artifact_plugin_call", "Call a deployment-installed server function as the authenticated user. May perform writes or outbound requests; consult plugins_list for operation schemas and read-only hints. Artifact or library selectors do not confer authority.", {
  plugin: { type: "string", minLength: 1 }, operation: { type: "string", minLength: 1 }, input: {},
}, ["plugin", "operation", "input"]);
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

addScriptTool("artifact_schedule", "Configure recurring requests to an artifact's latest validated native server. Uses Durable Object alarms, with no automatic retry after uncertain side effects. Exactly one of interval_seconds or cron is required for set; timezone defaults to UTC. run_now executes the configured request, including while paused. Historical previews do not change the scheduled revision.", {
  name: { type: "string", minLength: 1 }, action: { type: "string", enum: ["get", "set", "pause", "resume", "run_now"], default: "get" },
  interval_seconds: { type: "integer", minimum: 60, maximum: 31536000 }, cron: { type: "string", maxLength: 256 }, timezone: { type: "string", maxLength: 100 }, request: ARTIFACTS_REQUEST_SCHEMA,
}, ["name"]);
addScriptTool("artifact_runs", "Read recent native artifacts server invocations, their source revision, trigger, duration and outcome. Host-owned history is separate from application SQLite. An interrupted run may already have performed writes and is never automatically retried.", { name: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["name"]);
CLOUD_MCP_TOOLS[CLOUD_MCP_TOOLS.length - 1]!.annotations = { readOnlyHint: true };
// Project source is additive to legacy entrypoints; dependency locks are generated by the service.
const projectProperty = { type: "object", properties: {
  files: { type: "object", maxProperties: 64, additionalProperties: { type: "string" }, description: "Relative helper modules (.ts/.tsx/.js/.json). Import from ./path. Full replacement; omit project to preserve existing project." },
  dependencies: { type: "object", maxProperties: 32, additionalProperties: { type: "string" }, description: "npm package names mapped to exact versions, for example {hono: '4.13.7'}. Resolved only on dependency changes; source and transitive dependency contents are archived together." },
}, additionalProperties: false };
for (const tool of CLOUD_MCP_TOOLS) {
  if (tool.name === "artifact_write" || tool.name === "script_write") {
    tool.inputSchema.properties!.project = projectProperty;
    tool.inputSchema.properties!.expected_revision = {type:["string","null"],pattern:"^[a-f0-9]{64}$",description:"Full-project revision_token from a source snapshot. Rejects stale client/server/helper/dependency writes atomically. Null requires a new name; omit for an unconditional write."};
  }
  if (["artifact_read", "artifact_edit", "script_read", "script_edit"].includes(tool.name)) tool.inputSchema.properties!.file = {type:"string", description:"Select a relative project.files helper module instead of the entrypoint."};
}

const appName = { name: { type: "string", minLength: 1, maxLength: 255 } };
const revisionId = { type: "string", pattern: "^[a-f0-9]{64}$" };
addScriptTool("app_guide", "Read the native Worker manifest, ownership, private HTTP, deployment recovery and provider guide.", {});
addScriptTool("app_list", "List native Worker apps and deployment status in the authenticated library/workspace. Returns 100 per page and configured providers; never runs app code.", pageProperty);
addScriptTool("app_write", "Create or update an ordinary native Worker. Preserve default handler and named DO exports. Strict manifest declares app-owned native bindings; provider defaults to a configured provider and is fixed for an existing app. Stable resource names retain data on binding/class rename, removal and restoration. Persisted intent recovers provider mutations; failures require app_reconcile. Call app_guide first.", {
  ...appName, source: { type: "string", maxLength: 262144 }, manifest: { type: "object", maxProperties: 8 }, project: projectProperty,
  provider: { type: "string", enum: ["cloudflare", "celld-local"] }, expected_revision: { ...revisionId, type: ["string", "null"], description: "Full source/manifest/project revision_token from app_read. Null requires a new app; omit for unconditional write." },
}, ["name", "source", "manifest"]);
addScriptTool("app_read", "Read native Worker source, manifest, helper/dependency snapshot and deployment status. Optional revision_id reads immutable source; secrets and provider credentials are never returned.", { ...appName, revision_id: revisionId }, ["name"]);
addScriptTool("app_history", "List immutable compiled native Worker revisions, 100 per page. Secrets and resource data are separate from source history.", { ...appName, ...pageProperty }, ["name"]);
addScriptTool("app_restore", "Redeploy historical native Worker source against retained resources and current app secrets. Does not roll back schema/data or undo namespace migrations.", { ...appName, revision_id: revisionId }, ["name", "revision_id"]);
addScriptTool("app_reconcile", "Resume the current desired native Worker deployment after provider errors or interruption. Reuses reserved resource identities; never deletes storage.", appName, ["name"]);
addScriptTool("app_secrets", "Atomically set/delete app secrets (null deletes); omit secrets to list names. Values are only passed into declared native env bindings and never returned/history-exported. Existing desired code is redeployed to apply changes.", { ...appName, secrets: { type: "object", maxProperties: 32, additionalProperties: { type: ["string", "null"], maxLength: 4096 } } }, ["name"]);
addScriptTool("app_move", "Move an app between authenticated private/team libraries without changing its physical app identity, resources, secrets or revisions. The former owner immediately loses future management and HTTP access.", { ...appName, library: { type: "string", enum: ["private", "team"] } }, ["name", "library"]);
for (const tool of CLOUD_MCP_TOOLS.filter(tool => ["app_guide", "app_list", "app_read", "app_history"].includes(tool.name))) tool.annotations = { readOnlyHint: true };

for (const tool of [...ARTIFACTS_WORKSPACE_TOOLS, ARTIFACTS_FILE_TOOL]) if (!CLOUD_MCP_TOOLS.some(existing => existing.name === tool.name)) CLOUD_MCP_TOOLS.push(tool as Tool);
for (const tool of CLOUD_MCP_TOOLS) {
  if (["artifact_write", "artifact_edit", "artifact_import", "artifact_remix", "artifact_restore"].includes(tool.name)) tool.inputSchema.properties!.preview = { type: "boolean", default: true, description: "Deliver the preview after saving and activating a valid revision. False suppresses delivery only; it does not roll back the mutation." };
  if (["artifact_request", "artifact_files", "artifact_read", "artifact_export"].includes(tool.name)) tool.inputSchema.properties!.workspace = { type: "string", minLength: 1, description: "Workspace in the authenticated library. Does not grant access." };
  if (tool.name === "artifacts_search") tool.description += " Offset is a catalog-page offset: continue next_offset even when no names match the current page.";
  if (tool.name === "artifacts_mentions") tool.inputSchema.properties!.offset = { type: "integer", minimum: 0, description: "Continue the next_offset returned by a previous mention search." };
}
applyToolVisibility(CLOUD_MCP_TOOLS);
CLOUD_MCP_TOOLS.push(galleryToolDefinition(CLOUD_MCP_TOOLS));
CLOUD_MCP_TOOLS.push(...ARTIFACTS_SETTINGS_TOOLS);
