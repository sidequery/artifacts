import type { DurableObjectStub, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CanvasLibrary, CanvasEdit } from "./library";
import { compileCanvasSource, compileCanvasServerSource, typecheckCanvasSource, typecheckCanvasServerSource } from "./compiler";
import type { CanvasBackend } from "./backend";
import { nativeRequest } from "./backend";
import type { ArtifactLinks, ArtifactTarget, LinkUpdate } from "./links";
import type { ScriptLibrary } from "./scripts";
import type { ScriptBackend } from "./script-backend";
import { compileScriptSource } from "./compiler";
import { scriptResponse } from "./script-service-http";
export type HostedArtifacts = { links: DurableObjectStub<ArtifactLinks>; scripts: DurableObjectStub<ScriptLibrary>; scriptBackends: DurableObjectNamespace<ScriptBackend>; origin: string };
import type { CanvasHttpRequest } from "../src/httpTypes";
import { createHash } from "node:crypto";
import { formatCanvasCheck } from "../src/diagnostics";
import type { CanvasAppPayload } from "../src/mcpAppContract";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { runtime } from "../dist/cloudflare/identity.json";
import { canvasGuideResult } from "../src/canvasGuide";

type Snapshot = {
  workspace: string; name: string; path: string; source: string;
  server_source: string | null;
  state: Record<string, unknown>; version_id?: string | null;
};
type Mutation = Snapshot & { ok: boolean; applied?: boolean; changed?: boolean; restored?: boolean; source_hash?: string; edits_applied?: number; versionId?: string; revision?: number };
type Compiled = Awaited<ReturnType<typeof compileCanvasSource>>;

export class CloudCanvasService {
  constructor(readonly library: DurableObjectStub<CanvasLibrary>, readonly workspace: string,
    readonly backends: DurableObjectNamespace<CanvasBackend>, readonly libraryKey: string, readonly hosted?: HostedArtifacts) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name.startsWith("script_")) return this.scriptTool(name, args);
    if (name === "artifact_link") return this.artifactLink(args);
    switch (name) {
      case "canvas_guide": {
        const guide = canvasGuideResult();
        if (this.hosted) guide.content.push({ type: "text", text: HOSTED_SCRIPT_GUIDE });
        return guide;
      }
      case "canvas_list": {
        const offset = args.offset as number | undefined ?? 0;
        const canvases = await this.library.listDrafts({ workspace: this.workspace, offset });
        const entries = await Promise.all(canvases.map(async canvas => ({ ...canvas, ...await this.linkDetails(this.target("canvas", canvas.id)) })));
        return text({ canvases: entries, next_offset: canvases.length === 100 ? offset + 100 : null });
      }
      case "canvas_read": return text(await this.library.readRange({ workspace: this.workspace, name: args.name as string, part: args.part as "client" | "server" | undefined, start_line: args.start_line as number | undefined, end_line: args.end_line as number | undefined }));
      case "canvas_history": {
        const offset = args.offset as number | undefined ?? 0;
        const versions = await this.library.history({ workspace: this.workspace, name: args.name as string | undefined, offset });
        return text({ versions, next_offset: versions.length === 100 ? offset + 100 : null });
      }
      case "canvas_version": return text(await this.library.version({ workspace: this.workspace, id: args.version_id as string, events_offset: args.events_offset as number | undefined }));
      case "canvas_write": {
        const target = this.target("canvas", args.name as string);
        if (args.slug !== undefined) await this.requireHosted().links.check(target, args.slug as string);
        const generation = await this.hosted?.links.begin(target);
        return this.mutationResult(await this.library.writeDraft({ workspace: this.workspace, name: args.name as string, source: args.contents as string, server_source: args.server as string | null | undefined }), generation, { ...(args.slug === undefined ? {} : { slug: args.slug as string }), ...(args.access === undefined ? {} : { access: args.access as "private" | "public" }) });
      }
      case "canvas_edit": {
        const generation = await this.hosted?.links.begin(this.target("canvas", args.name as string));
        return this.mutationResult(await this.library.editDraft({ workspace: this.workspace, name: args.name as string, part: args.part as "client" | "server" | undefined, edits: args.edits as CanvasEdit[], expected_hash: args.expected_hash as string | undefined }), generation);
      }
      case "canvas_restore": {
        const version = await this.library.version({ workspace: this.workspace, id: args.version_id as string });
        const generation = await this.hosted?.links.begin(this.target("canvas", version.name));
        return this.mutationResult(await this.library.restore({ workspace: this.workspace, id: args.version_id as string, runtime }), generation);
      }
      case "canvas_typecheck": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const diagnostics = [...typecheckCanvasSource(snapshot.source), ...(snapshot.server_source === null ? [] : typecheckCanvasServerSource(snapshot.server_source))];
        return text({ path: snapshot.path, check: formatCanvasCheck(diagnostics), diagnostics }, diagnostics.length > 0);
      }
      case "canvas_compile": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const compiled = await this.compile(snapshot);
        return text({ ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics, bytes: compiled.js?.length ?? 0 }, !compiled.ok);
      }
      case "canvas_open": {
        const snapshot = await this.snapshot(args as { name?: string; version_id?: string; event_id?: string });
        const preview = await this.preview(snapshot);
        const { _meta, ...payload } = preview;
        return { ...text(payload, !preview.ok), structuredContent: payload, ...(_meta ? { _meta } : {}) };
      }
      case "canvas_request": {
        const response = await this.request({ name: args.name as string | undefined, version_id: args.version_id as string | undefined }, args.request as CanvasHttpRequest);
        return { ...text({ status: response.status }), structuredContent: { response } };
      }
      default: throw new Error("Unknown tool");
    }
  }

  snapshot(selection: { name?: string; version_id?: string; event_id?: string }): Promise<Snapshot> {
    return this.library.preview({ workspace: this.workspace, ...selection });
  }

  async preview(snapshot: Snapshot, compiled?: Compiled) {
    compiled ??= await this.compile(snapshot);
    const base = { ...await this.linkDetails(this.target("canvas", snapshot.name)), ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok || !compiled.js) return { ...base, ok: false, _meta: undefined };
    const { version, event } = await this.library.recordServe({
      workspace: snapshot.workspace, name: snapshot.name, source: snapshot.source,
      server_source: snapshot.server_source,
      runtime, initial_state: snapshot.state, mode: "preview",
      ...(snapshot.version_id ? { version_id: snapshot.version_id } : {}),
    });
    const canvas = { name: version.name, versionId: version.id, eventId: event.id, sourceHash: version.source_hash };
    return { ...base, ok: true, canvas, _meta: { canvas: { ...canvas, js: compiled.js, state: snapshot.state, server: snapshot.server_source !== null } satisfies CanvasAppPayload } };
  }

  private async mutationResult(mutation: Mutation, generation?: number | null, settings: LinkUpdate = {}): Promise<CallToolResult> {
    const { source, server_source, state, ...summary } = mutation;
    const target = this.target("canvas", mutation.name);
    if (generation != null) {
      await this.hosted!.links.stage(target, generation, settings);
      settings = { ...await this.hosted!.links.draft(target), ...settings };
    }
    const compiled = await this.compile(mutation);
    const payload = { ...summary, ...await this.linkDetails(this.target("canvas", mutation.name)), applied: true, ok: compiled.ok, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok) return { ...text(payload, true), structuredContent: payload };
    // The draft is already committed. A delivery error must never look like a
    // rollback, and compilation must use that exact committed source snapshot.
    try {
      const { _meta, ...details } = await this.preview(mutation, compiled);
      const target = this.target("canvas", mutation.name);
      if (generation != null && details.ok && "canvas" in details && (settings.slug !== undefined || await this.hosted!.links.find(target))) {
        const link = await this.hosted!.links.commit(target, generation, { ...settings, version_id: details.canvas.versionId });
        if (!link) {
          const superseded = { ...payload, ok: false, superseded: true, error: "A newer update superseded this URL activation" };
          return { ...text(superseded, true), structuredContent: superseded };
        }
      }
      const result = { ...payload, ...await this.linkDetails(target) };
      return { ...text(result, !details.ok), structuredContent: { ...result, preview: { ...details, ...await this.linkDetails(target) } }, ...(_meta ? { _meta } : {}) };
    } catch (error) {
      const failed = { ...payload, ok: false, preview: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      return { ...text(failed, true), structuredContent: failed };
    }
  }

  private async compile(snapshot: Snapshot): Promise<Compiled> {
    const client = await compileCanvasSource(snapshot.source);
    if (snapshot.server_source === null) return client;
    const server = await compileCanvasServerSource(snapshot.server_source);
    return { ...client, ok: client.ok && server.ok, diagnostics: [...client.diagnostics, ...server.diagnostics] };
  }

  async request(selection: { name?: string; version_id?: string }, request: CanvasHttpRequest) {
    const snapshot = await this.snapshot(selection.version_id ? { version_id: selection.version_id } : { name: selection.name });
    if (selection.name && snapshot.name !== selection.name.trim().replace(/\.canvas\.tsx$/, "")) throw new Error("Server version does not belong to this canvas");
    if (snapshot.server_source === null) throw new Error("Canvas has no server");
    const compiled = await compileCanvasServerSource(snapshot.server_source);
    if (!compiled.ok || !compiled.js) throw new Error(formatCanvasCheck(compiled.diagnostics));
    const hash = createHash("sha256").update(compiled.js).digest("hex");
    const backend = this.backends.getByName(JSON.stringify([this.libraryKey, this.workspace, snapshot.name]));
    return backend.request({ code: compiled.js, hash, request });
  }

  private requireHosted(): HostedArtifacts {
    if (!this.hosted) throw new Error("Standalone artifacts are unavailable in this runtime");
    return this.hosted;
  }

  private target(kind: "canvas" | "script", name: string): ArtifactTarget {
    return { libraryKey: this.libraryKey, workspace: this.workspace, kind, name: name.trim().replace(kind === "canvas" ? /\.canvas\.tsx$/ : /\.script\.ts$/, "") };
  }

  private async linkDetails(target: ArtifactTarget) {
    const link = await this.hosted?.links.find(target);
    if (link) return { slug: link.slug, access: link.access, url: `${this.hosted!.origin}/${link.slug}` };
    const pending = await this.hosted?.links.draft(target);
    return pending?.slug ? { slug: pending.slug, access: pending.access ?? "private" } : {};
  }

  private async artifactLink(args: Record<string, unknown>): Promise<CallToolResult> {
    const hosted = this.requireHosted();
    if (args.kind !== "canvas" && args.kind !== "script") throw new Error("kind must be canvas or script");
    const target = this.target(args.kind, args.name as string);
    const existing = await hosted.links.find(target);
    if ((target.kind === "canvas" && existing?.version_id) || (target.kind === "script" && existing?.script_hash)) {
      // Access changes must work even while the current draft is invalid. Keep
      // serving the already validated revision when renaming or restricting it.
      await hosted.links.set({ ...target, slug: args.slug as string, access: args.access as "private" | "public" | undefined });
      return text({ ok: true, ...await this.linkDetails(target) });
    }
    await hosted.links.check(target, args.slug as string);
    const generation = await hosted.links.begin(target);
    const settings = { slug: args.slug as string, ...(args.access === undefined ? {} : { access: args.access as "private" | "public" }) };
    if (target.kind === "script") {
      const active = await hosted.scripts.active({ workspace: this.workspace, name: target.name });
      const link = await hosted.links.commit(target, generation, { ...settings, script_hash: active.hash });
      return link ? text({ ok: true, ...await this.linkDetails(target) }) : text({ ok: false, superseded: true, error: "A newer update superseded this URL activation" }, true);
    }
    const snapshot = await this.snapshot({ name: target.name });
    const compiled = await this.compile(snapshot);
    if (!compiled.ok) return text({ ok: false, diagnostics: compiled.diagnostics, check: formatCanvasCheck(compiled.diagnostics) }, true);
    const { _meta, ...preview } = await this.preview(snapshot, compiled);
    if (preview.ok && "canvas" in preview) {
      const link = await hosted.links.commit(target, generation, { ...settings, version_id: preview.canvas.versionId });
      if (!link) return text({ ok: false, superseded: true, error: "A newer update superseded this URL activation" }, true);
    }
    return { ...text({ ...preview, ...await this.linkDetails(target) }), ...(_meta ? { _meta } : {}) };
  }

  async scriptReadSource(selection: { name?: string; version_id?: string }) {
    const scripts = this.requireHosted().scripts;
    if (selection.version_id) {
      const version = await scripts.version({ workspace: this.workspace, id: selection.version_id });
      if (selection.name && version.name !== this.target("script", selection.name).name) throw new Error("Version does not belong to this script");
      return { ...version, path: `${this.workspace}/${version.name}.script.ts` };
    }
    if (!selection.name) throw new Error("name or version_id is required");
    return scripts.readRange({ workspace: this.workspace, name: selection.name, end_line: Number.MAX_SAFE_INTEGER });
  }

  private async scriptTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const hosted = this.requireHosted(), scripts = hosted.scripts;
    const name = args.name as string, input = { workspace: this.workspace, name };
    const offset = args.offset as number | undefined ?? 0;
    switch (tool) {
      case "script_list": {
        const drafts = await scripts.listDrafts({ workspace: this.workspace, offset });
        const entries = await Promise.all(drafts.map(async draft => ({ ...draft, ...await this.linkDetails(this.target("script", draft.name)) })));
        return text({ scripts: entries, next_offset: entries.length === 100 ? offset + 100 : null });
      }
      case "script_read": {
        if (!args.version_id) return text(await scripts.readRange({ ...input, start_line: args.start_line as number | undefined, end_line: args.end_line as number | undefined }));
        const version = await this.scriptReadSource({ name, version_id: args.version_id as string });
        const lines = version.source.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
        const start = args.start_line as number | undefined ?? 1, end = args.end_line as number | undefined ?? start + 199;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || start > lines.length) throw new Error("invalid line range");
        const actualEnd = Math.min(end, lines.length);
        return text({ ...version, source: lines.slice(start - 1, actualEnd).join(""), start_line: start, end_line: actualEnd, total_lines: lines.length, next_line: actualEnd < lines.length ? actualEnd + 1 : null });
      }
      case "script_history": {
        const versions = await scripts.history({ workspace: this.workspace, name, offset });
        return text({ versions, next_offset: versions.length === 100 ? offset + 100 : null });
      }
      case "script_version": return text(await scripts.version({ workspace: this.workspace, id: args.version_id as string }));
      case "script_logs": return text({ logs: await hosted.scriptBackends.getByName(JSON.stringify([this.libraryKey, this.workspace, this.target("script", name).name])).logs({ limit: args.limit as number | undefined }) });
      case "script_secrets": {
        if (args.secrets !== undefined) {
          if (!args.secrets || typeof args.secrets !== "object" || Array.isArray(args.secrets)) throw new Error("secrets must be an object");
          for (const [key, value] of Object.entries(args.secrets)) await scripts.setSecret({ ...input, key, value: value as string | null });
        }
        return text({ ok: true, names: await scripts.secretNames(input) });
      }
      case "script_run": {
        const link = await hosted.links.find(this.target("script", name));
        if (!link?.script_hash) throw new Error("Script has no validated URL revision");
        const active = await scripts.active({ ...input, hash: link.script_hash });
        const incoming = nativeRequest(args.request as CanvasHttpRequest);
        const request = new Request(new URL(new URL(incoming.url).pathname + new URL(incoming.url).search, hosted.origin), incoming);
        const response = await hosted.scriptBackends.getByName(JSON.stringify([this.libraryKey, this.workspace, this.target("script", name).name])).request({ ...active, request });
        const envelope = await scriptResponse(response, incoming.method);
        return { ...text({ status: envelope.status, ...(link ? { url: `${hosted.origin}/${link.slug}` } : {}) }), structuredContent: { response: envelope } };
      }
      case "script_write": case "script_edit": case "script_restore": {
        const target = this.target("script", name);
        // Read pending intent only after taking this operation's generation.
        // A concurrent explicit access change then either precedes this read or
        // supersedes this generation; it cannot be undone by stale metadata.
        const generation = await hosted.links.begin(target);
        const settings: LinkUpdate = await hosted.links.draft(target);
        if (tool === "script_write") {
          const previous = await hosted.links.find(target);
          settings.slug = args.slug as string | undefined ?? settings.slug ?? previous?.slug ?? target.name;
          if (args.access !== undefined) settings.access = args.access as "private" | "public";
        }
        if (settings.slug !== undefined) await hosted.links.check(target, settings.slug);
        if (tool === "script_restore") {
          const version = await scripts.version({ workspace: this.workspace, id: args.version_id as string });
          if (version.name !== target.name) throw new Error("Version does not belong to this script");
        }
        const mutation = tool === "script_write" ? await scripts.writeDraft({ ...input, source: args.contents as string })
          : tool === "script_edit" ? await scripts.editDraft({ ...input, edits: args.edits as CanvasEdit[], expected_hash: args.expected_hash as string | undefined })
          : await scripts.restore({ workspace: this.workspace, id: args.version_id as string });
        await hosted.links.stage(target, generation, settings);
        const compiled = await compileScriptSource(mutation.source);
        if (compiled.ok && compiled.js) {
          const secrets = await scripts.executionSecrets(input);
          const backend = hosted.scriptBackends.getByName(JSON.stringify([this.libraryKey, this.workspace, target.name]));
          const validation = await backend.validate({ code: compiled.js, hash: createHash("sha256").update(compiled.js).digest("hex"), secrets });
          if (validation.ok) {
            try {
              const activated = await scripts.activate({ ...input, source_hash: mutation.source_hash, code: compiled.js });
              const link = await hosted.links.commit(target, generation, { ...settings, script_hash: activated.hash });
              if (!link) {
                const { source, ...summary } = mutation;
                const superseded = { ...summary, ...await this.linkDetails(target), applied: true, ok: false, superseded: true, error: "A newer update superseded this URL activation" };
                return { ...text(superseded, true), structuredContent: superseded };
              }
            } catch (error) {
              const { source, ...summary } = mutation;
              const message = error instanceof Error ? error.message : "Script URL activation failed";
              const failed = { ...summary, ...await this.linkDetails(target), applied: true, ok: false, ...(message.includes("changed during validation") ? { superseded: true } : {}), error: message };
              return { ...text(failed, true), structuredContent: failed };
            }
          } else {
            compiled.ok = false;
            compiled.diagnostics.push({ severity: "error", message: "Script module could not initialize" });
          }
        }
        const { source, ...summary } = mutation;
        const payload = { ...summary, ...await this.linkDetails(target), applied: true, ok: compiled.ok, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
        return { ...text(payload, !compiled.ok), structuredContent: payload };
      }
      default: throw new Error("Unknown script tool");
    }
  }

  async gallery(all: boolean, offset = 0): Promise<GalleryData> {
    const artifacts = new Map<string, GalleryArtifact>();
    const filter = all ? { offset } : { workspace: this.workspace, offset };
    const versions = await this.library.history(filter);
    const drafts = await this.library.listDrafts(filter);
    for (const version of versions) {
      const key = JSON.stringify([version.workspace, version.name]);
      const artifact = artifacts.get(key) ?? { key, name: version.name, workspace: version.workspace, working: false, versions: [] };
      artifact.versions.push({ id: version.version_id, revision: version.revision, createdAt: version.created_at, reason: version.reason, serveCount: version.serve_count });
      artifacts.set(key, artifact);
    }
    for (const draft of drafts) {
      const key = JSON.stringify([draft.workspace, draft.id]);
      const artifact = artifacts.get(key) ?? { key, name: draft.id, workspace: draft.workspace, working: false, versions: [] };
      artifact.working = true;
      artifacts.set(key, artifact);
    }
    let scriptsHaveMore = false;
    if (this.hosted) {
      const drafts = await this.hosted.scripts.listDrafts(filter);
      const history = await this.hosted.scripts.history(filter);
      scriptsHaveMore = drafts.length === 100 || history.length === 100;
      for (const version of history) {
        const key = JSON.stringify(["script", version.workspace, version.name]);
        const artifact = artifacts.get(key) ?? { key, name: version.name, workspace: version.workspace, working: false, kind: "script" as const, versions: [] };
        artifact.versions.push({ id: version.id, revision: version.revision, createdAt: version.created_at, reason: version.reason, serveCount: 0 });
        artifacts.set(key, artifact);
      }
      for (const draft of drafts) {
        const key = JSON.stringify(["script", draft.workspace, draft.name]);
        const artifact = artifacts.get(key) ?? { key, name: draft.name, workspace: draft.workspace, working: false, kind: "script" as const, versions: [] };
        artifact.working = true;
        artifacts.set(key, artifact);
      }
      for (const artifact of artifacts.values()) {
        artifact.kind ??= "canvas";
        Object.assign(artifact, await this.linkDetails({ libraryKey: this.libraryKey, workspace: artifact.workspace, name: artifact.name, kind: artifact.kind }));
      }
    }
    return { ...(this.hosted ? { capabilities: { scripts: true, links: true } } : {}), workspace: this.workspace, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: scriptsHaveMore || versions.length === 100 || drafts.length === 100 ? offset + 100 : null };
  }
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

const HOSTED_SCRIPT_GUIDE = `Hosted standalone scripts and root URLs

Canvases and scripts coexist. Use canvas_write with an optional slug, or artifact_link({kind:"canvas",name,slug,access}), to give a canvas a self-contained root URL. Script writes choose slug explicitly or default to the script name. Root slugs are unique across this deployment, use lowercase letters/numbers/hyphens, and exclude application routes. No namespace or type prefix is added. Names and slugs are separate. Private is the default; access:"public" enables external callers. Management remains authenticated.

Create arbitrary Workers-compatible TypeScript using script_write({name,slug,contents,access}). Export default {async fetch(request, env, ctx) { return new Response("Hello"); }}. A handler can return HTML, JSON, binary responses, or streams, receive webhooks, or call external APIs through fetch. Supported runtime bindings are env.secrets (explicitly configured per-script values) and env.sql (persistent native SQLite, with .exec and bound parameters). ScriptEnv and ExecutionContext types are available. No application credentials are implicitly supplied. Bare package imports must be supported by the compiler; unresolved dependencies produce diagnostics.

Use script_secrets({name,secrets:{TOKEN:"value",OLD_TOKEN:null}}) to set/delete values, or omit secrets to list names. Values never appear in source history or management reads. Use env.secrets.TOKEN inside the handler. Avoid returning secrets in HTTP responses. Initialize database tables with create table if not exists; source edits/restores preserve the database.

script_write and script_edit save source before validation. Inspect applied, ok, and diagnostics: failed drafts remain editable, while the URL keeps serving the last validated code. No separate publish operation is needed. script_read reads draft or historical source, script_history lists revisions, script_version reads one, and script_restore restores and validates a prior revision. script_list, script_read, and gallery views never execute handlers.

script_run({name,request:{path:"/chosen-slug?key=value",method:"POST",headers:[["content-type","text/plain"]],body:"aGVsbG8="}}) explicitly invokes the last validated handler. The request path and query are passed exactly as provided, using the deployment origin; include the slug in path to reproduce a direct URL request. Body is base64. MCP requests and responses are limited to 256 KiB; use direct URLs for streaming or larger responses. script_logs reads bounded recent execution logs and errors. Direct URLs preserve incoming paths, methods, headers and body bytes and return the handler response. Public handlers can implement their own authentication, including provider signature checks.
`;
