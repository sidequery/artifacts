import browserRuntime from "../dist/cloudflare/browser-runtime.json";
import { resolveProject, type ArtifactProject } from "./project";
import type { DurableObjectStub, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CanvasLibrary, CanvasEdit, CompiledCanvas } from "./library";
import { compileCanvasSource, compileCanvasServerSource, typecheckCanvasSource, typecheckCanvasServerSource } from "./compiler";
import type { CanvasScheduleInput } from "./canvas-execution";
import type { CanvasBackend } from "./backend";
import type { LinkUpdate } from "./links";
import { ArtifactService, type HostedArtifacts } from "./artifact-service";
import { CloudScriptService } from "./script-service";
import { HOSTED_SCRIPT_GUIDE } from "./script-guide";
export type { HostedArtifacts } from "./artifact-service";
import type { CanvasHttpRequest } from "../src/httpTypes";
import { createHash } from "node:crypto";
import { formatCanvasCheck, type Diagnostic } from "../src/diagnostics";
import type { CanvasAppPayload } from "../src/mcp/app-contract";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { runtime } from "../dist/cloudflare/identity.json";
import { canvasGuideResult } from "../src/mcp/guide";
import type { CanvasFiles } from "./files";
import { CanvasFileError, validateFileRequest } from "./files";
import type { CanvasFileRequest } from "../src/sdk/files";

import { dispatchPlugin, pluginCatalog, PLUGIN_GUIDE, type PluginInvocationContext } from "./plugins";
import type { PluginRequest } from "../src/plugins/types";

type Snapshot = {
  workspace: string; name: string; path: string; source: string;
  server_source: string | null;
  project?: ArtifactProject;
  state: Record<string, unknown>; version_id?: string | null; compiled_id?: string | null;
};
type Mutation = Snapshot & { ok: boolean; applied?: boolean; changed?: boolean; restored?: boolean; source_hash?: string; edits_applied?: number; versionId?: string; revision?: number };
type Compiled = { ok: boolean; js?: string; diagnostics: Diagnostic[]; artifact?: CompiledCanvas };

export class CloudCanvasService {
  private readonly artifacts: ArtifactService;
  private readonly scripts: CloudScriptService;

  constructor(readonly library: DurableObjectStub<CanvasLibrary>, readonly workspace: string,
    readonly backends: DurableObjectNamespace<CanvasBackend>, readonly libraryKey: string, readonly hosted?: HostedArtifacts, readonly plugins?: PluginInvocationContext,
    readonly fileStorage?: { backends: DurableObjectNamespace<CanvasFiles>; origin: string }) {
    this.artifacts = new ArtifactService(workspace, libraryKey, hosted);
    this.scripts = new CloudScriptService(this.artifacts);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name.startsWith("script_")) return this.scripts.callTool(name, args);
    if (name === "artifact_link") return this.artifactLink(args);
    switch (name) {
      case "canvas_files": {
        const result = await this.fileRequest(args as { name?: string; version_id?: string }, args.request as CanvasFileRequest);
        return { ...text({ result }), structuredContent: { result } };
      }
      case "plugins_list": return { ...text({ plugins: pluginCatalog }), structuredContent: { plugins: pluginCatalog } };
      case "plugin_guide": return text(PLUGIN_GUIDE);
      case "canvas_plugin_call": {
        const result = await this.pluginCall(args as PluginRequest);
        return { ...text({ result }), structuredContent: { result } };
      }
      case "canvas_guide": {
        const guide = canvasGuideResult();
        if (this.hosted) guide.content.push({ type: "text", text: HOSTED_SCRIPT_GUIDE });
        return guide;
      }
      case "canvas_list": {
        const offset = args.offset as number | undefined ?? 0;
        const canvases = await this.library.listDrafts({ workspace: this.workspace, offset });
        const entries = await Promise.all(canvases.map(async canvas => ({ ...canvas, ...await this.artifacts.linkDetails(this.artifacts.target("canvas", canvas.id)) })));
        return text({ canvases: entries, next_offset: canvases.length === 100 ? offset + 100 : null });
      }
      case "canvas_read": return text(await this.library.readRange({ workspace: this.workspace, name: args.name as string, file: args.file as string | undefined, part: args.part as "client" | "server" | undefined, start_line: args.start_line as number | undefined, end_line: args.end_line as number | undefined }));
      case "canvas_history": {
        const offset = args.offset as number | undefined ?? 0;
        const versions = await this.library.history({ workspace: this.workspace, name: args.name as string | undefined, offset });
        return text({ versions, next_offset: versions.length === 100 ? offset + 100 : null });
      }
      case "canvas_version": return text(await this.library.version({ workspace: this.workspace, id: args.version_id as string, events_offset: args.events_offset as number | undefined }));
      case "canvas_remix": {
        const target = this.artifacts.target("canvas", args.new_name as string);
        const slug = args.slug as string | undefined ?? target.name;
        if (this.hosted) await this.hosted.links.check(target, slug);
        const mutation = await this.library.remix({workspace:this.workspace,name:args.name as string | undefined,version_id:args.version_id as string | undefined,new_name:args.new_name as string,runtime});
        const generation = await this.hosted?.links.begin(target);
        return this.mutationResult(mutation, generation, this.hosted ? {slug,access:"private"} : {});
      }
      case "canvas_write": {
        const target = this.artifacts.target("canvas", args.name as string);
        if (args.slug !== undefined) await this.artifacts.requireHosted().links.check(target, args.slug as string);
        const generation = await this.hosted?.links.begin(target);
        const previous = args.project === undefined ? undefined : await this.snapshot({name: args.name as string}).catch(error => { if (error instanceof Error && error.message.includes("canvas not found")) return undefined; throw error; });
        const project = args.project === undefined ? undefined : await resolveProject(args.project, previous?.project, fetch, browserRuntime.sharedVersions);
        return this.mutationResult(await this.library.writeDraft({ workspace: this.workspace, name: args.name as string, source: args.contents as string, server_source: args.server as string | null | undefined, project }), generation, { ...(args.slug === undefined ? {} : { slug: args.slug as string }), ...(args.access === undefined ? {} : { access: args.access as "private" | "public" }) });
      }
      case "canvas_edit": {
        const generation = await this.hosted?.links.begin(this.artifacts.target("canvas", args.name as string));
        return this.mutationResult(await this.library.editDraft({ workspace: this.workspace, name: args.name as string, file: args.file as string | undefined, part: args.part as "client" | "server" | undefined, edits: args.edits as CanvasEdit[], expected_hash: args.expected_hash as string | undefined }), generation);
      }
      case "canvas_restore": {
        const version = await this.library.version({ workspace: this.workspace, id: args.version_id as string });
        const generation = await this.hosted?.links.begin(this.artifacts.target("canvas", version.name));
        return this.mutationResult(await this.library.restore({ workspace: this.workspace, id: args.version_id as string, runtime }), generation);
      }
      case "canvas_typecheck": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const diagnostics = [...typecheckCanvasSource(snapshot.source, snapshot.project), ...(snapshot.server_source === null ? [] : typecheckCanvasServerSource(snapshot.server_source, snapshot.project))];
        return text({ path: snapshot.path, check: formatCanvasCheck(diagnostics), diagnostics }, diagnostics.length > 0);
      }
      case "canvas_compile": {
        const snapshot = await this.snapshot({ name: args.name as string | undefined, version_id: args.version_id as string | undefined });
        const compiled = await this.compile(snapshot);
        if (compiled.artifact && snapshot.version_id) await this.library.attachCompiled({ workspace: snapshot.workspace, name: snapshot.name,
          version_id: snapshot.version_id, compiled_id: compiled.artifact.id,
        });
        return text({ ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics, bytes: compiled.js?.length ?? 0 }, !compiled.ok);
      }
      case "canvas_open": {
        const snapshot = await this.snapshot(args as { name?: string; version_id?: string; event_id?: string });
        const preview = await this.preview(snapshot);
        const { _meta, ...payload } = preview;
        return { ...text(payload, !preview.ok), structuredContent: payload, ...(_meta ? { _meta } : {}) };
      }
      case "canvas_schedule":
      case "canvas_runs": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const backend = this.backends.getByName(JSON.stringify([this.libraryKey, this.workspace, snapshot.name]));
        if (name === "canvas_runs") {
          const payload = { runs: await backend.runs({ limit: args.limit as number | undefined }) };
          return { ...text(payload), structuredContent: payload };
        }
        // Existing canvases gain a validated active revision when first scheduled.
        // Reads and pause remain usable while a draft is invalid.
        if (args.action === "set" || args.action === "resume") {
          const current = await backend.activeRevision();
          if (!current) {
            const compiled = await this.compile(snapshot);
            if (!compiled.ok) throw new Error(formatCanvasCheck(compiled.diagnostics));
            const preview = await this.preview(snapshot, compiled);
            if (preview.ok && "canvas" in preview) await this.activate(snapshot, preview.canvas.versionId, preview.canvas.revision, compiled);
          }
        }
        const { name: _name, ...input } = args;
        const payload = { schedule: await backend.schedule(input as CanvasScheduleInput) };
        return { ...text(payload), structuredContent: payload };
      }
      case "canvas_request": {
        const response = await this.request({ name: args.name as string | undefined, version_id: args.version_id as string | undefined }, args.request as CanvasHttpRequest, "manual");
        return { ...text({ status: response.status }), structuredContent: { response } };
      }
      default: throw new Error("Unknown tool");
    }
  }

  pluginCall(request: PluginRequest) { return dispatchPlugin(request, this.plugins); }

  snapshot(selection: { name?: string; version_id?: string; event_id?: string }): Promise<Snapshot> {
    return this.library.preview({ workspace: this.workspace, ...selection });
  }

  async preview(snapshot: Snapshot, compiled?: Compiled) {
    compiled ??= await this.savedCompilation(snapshot);
    const base = { ...await this.artifacts.linkDetails(this.artifacts.target("canvas", snapshot.name)), ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok || !compiled.js || !compiled.artifact) return { ...base, ok: false, _meta: undefined };
    const { version, event } = await this.library.recordServe({
      workspace: snapshot.workspace, name: snapshot.name, source: snapshot.source,
      server_source: snapshot.server_source, project: snapshot.project,
      runtime: compiled.artifact.runtime, compiled_id: compiled.artifact.id, initial_state: snapshot.state, mode: "preview",
      ...(snapshot.version_id ? { version_id: snapshot.version_id } : {}),
    });
    const canvas = { name: version.name, versionId: version.id, revision: version.revision, eventId: event.id, sourceHash: version.source_hash };
    return { ...base, ok: true, canvas, _meta: { canvas: { ...canvas, js: compiled.js, state: snapshot.state, server: snapshot.server_source !== null, ...(this.plugins ? { plugins: true } : {}), ...(this.fileStorage ? { files: true } : {}) } satisfies CanvasAppPayload } };
  }

  private async mutationResult(mutation: Mutation, generation?: number | null, settings: LinkUpdate = {}): Promise<CallToolResult> {
    const { source, server_source, state, project, ...summary } = mutation;
    const target = this.artifacts.target("canvas", mutation.name);
    if (generation != null) {
      await this.hosted!.links.stage(target, generation, settings);
      settings = { ...await this.hosted!.links.draft(target), ...settings };
    }
    // Restore already created its history revision. Attach the compiled pair to
    // that revision rather than capturing another revision during the preview.
    const snapshot = mutation.versionId ? { ...mutation, version_id: mutation.versionId } : mutation;
    const compiled = await this.compile(snapshot);
    const payload = { ...summary, ...await this.artifacts.linkDetails(this.artifacts.target("canvas", mutation.name)), applied: true, ok: compiled.ok, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok) return { ...text(payload, true), structuredContent: payload };
    // The draft is already committed. A delivery error must never look like a
    // rollback, and compilation must use that exact committed source snapshot.
    try {
      const { _meta, ...details } = await this.preview(snapshot, compiled);
      const target = this.artifacts.target("canvas", mutation.name);
      if (generation != null && details.ok && "canvas" in details && (settings.slug !== undefined || await this.hosted!.links.find(target))) {
        const link = await this.hosted!.links.commit(target, generation, { ...settings, version_id: details.canvas.versionId });
        if (!link) {
          const superseded = { ...payload, ok: false, superseded: true, error: "A newer update superseded this URL activation" };
          return { ...text(superseded, true), structuredContent: superseded };
        }
      }
      if (details.ok && "canvas" in details) await this.activate(mutation, details.canvas.versionId, details.canvas.revision, compiled);
      const result = { ...payload, ...await this.artifacts.linkDetails(target) };
      return { ...text(result, !details.ok), structuredContent: { ...result, preview: { ...details, ...await this.artifacts.linkDetails(target) } }, ...(_meta ? { _meta } : {}) };
    } catch (error) {
      const failed = { ...payload, ok: false, preview: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      return { ...text(failed, true), structuredContent: failed };
    }
  }

  private async compile(snapshot: Snapshot): Promise<Compiled> {
    // Only mutations, explicit compile, and first link creation call this path.
    // The exact pair and compiler identity prevent client-only hashes from
    // hiding server edits, and let unchanged writes reuse completed work.
    const saved = await this.library.compiled({ workspace: snapshot.workspace, name: snapshot.name,
      ...(snapshot.compiled_id ? { id: snapshot.compiled_id } : { source: snapshot.source, server_source: snapshot.server_source, project: snapshot.project, runtime }),
    });
    if (saved) return { ok: true, js: saved.client_js, diagnostics: [], artifact: saved };
    const client = await compileCanvasSource(snapshot.source, snapshot.project);
    if (!client.ok || !client.js) return client;
    const server = snapshot.server_source === null ? null : await compileCanvasServerSource(snapshot.server_source, snapshot.project);
    if (server && (!server.ok || !server.js)) return { ok: false, diagnostics: server.diagnostics };
    const artifact = await this.library.saveCompiled({ workspace: snapshot.workspace, name: snapshot.name,
      source: snapshot.source, server_source: snapshot.server_source, project: snapshot.project, runtime, client_js: client.js, server_js: server?.js ?? null,
    });
    return { ok: true, js: artifact.client_js, diagnostics: [], artifact };
  }

  private async savedCompilation(snapshot: Snapshot): Promise<Compiled> {
    const artifact = snapshot.version_id && !snapshot.compiled_id ? null : await this.library.compiled({ workspace: snapshot.workspace, name: snapshot.name,
      ...(snapshot.compiled_id ? { id: snapshot.compiled_id } : { source: snapshot.source, server_source: snapshot.server_source, project: snapshot.project }),
    });
    if (artifact) return { ok: true, js: artifact.client_js, diagnostics: [], artifact };
    // Old installations have source/history but no saved bundles. Backfill via
    // canvas_compile; reads must never silently launch the compiler.
    return { ok: false, diagnostics: [{ severity: "error", file: snapshot.path,
      message: "This canvas has no saved compiled artifact. Run canvas_compile with its name or version_id, or save a valid edit, before opening it.",
    }] };
  }

  private async activate(snapshot: Snapshot, version_id: string, revision: number, compiled: Compiled) {
    if (!compiled.ok || !compiled.artifact) throw new Error(formatCanvasCheck(compiled.diagnostics));
    const code = compiled.artifact.server_js;
    const hash = createHash("sha256").update(code ?? "").digest("hex");
    await this.backends.getByName(JSON.stringify([this.libraryKey, this.workspace, snapshot.name])).activate({ code, hash, version_id, revision });
  }

  async request(selection: { name?: string; version_id?: string }, request: CanvasHttpRequest, trigger: "http" | "manual" = "http") {
    const snapshot = await this.snapshot(selection.version_id ? { version_id: selection.version_id } : { name: selection.name });
    if (selection.name && snapshot.name !== selection.name.trim().replace(/\.canvas\.tsx$/, "")) throw new Error("Server version does not belong to this canvas");
    if (snapshot.server_source === null) throw new Error("Canvas has no server");
    const compiled = await this.savedCompilation(snapshot);
    if (!compiled.ok || !compiled.artifact?.server_js) throw new Error(formatCanvasCheck(compiled.diagnostics));
    const code = compiled.artifact.server_js;
    const hash = createHash("sha256").update(code).digest("hex");
    const backend = this.backends.getByName(JSON.stringify([this.libraryKey, this.workspace, snapshot.name]));
    return backend.request({ code, hash, version_id: snapshot.version_id ?? undefined, request, trigger });
  }

  async fileRequest(selection: { name?: string; version_id?: string }, input: CanvasFileRequest, writable = true): Promise<unknown> {
    validateFileRequest(input);
    if (!writable && input.operation !== "list" && input.operation !== "download") throw new CanvasFileError("Public canvases have read-only file access", 403);
    if (!this.fileStorage) throw new CanvasFileError("Canvas file storage is not configured", 503);
    if (!selection.name && !selection.version_id) throw new CanvasFileError("Select a canvas name or version_id");
    const snapshot = await this.snapshot(selection.version_id ? { version_id: selection.version_id } : { name: selection.name });
    if (selection.name && snapshot.name !== selection.name.trim().replace(/\.canvas\.tsx$/, "")) throw new CanvasFileError("File version does not belong to this canvas");
    const backend = this.fileStorage.backends.getByName(JSON.stringify([this.libraryKey, this.workspace, snapshot.name]));
    const result = await backend.request(input);
    if (result && typeof result === "object" && "path" in result && typeof result.path === "string") {
      const { path, ...details } = result;
      return { ...details, url: new URL(path, this.fileStorage.origin).href };
    }
    return result;
  }

  private async artifactLink(args: Record<string, unknown>): Promise<CallToolResult> {
    const hosted = this.artifacts.requireHosted();
    if (args.kind !== "canvas" && args.kind !== "script") throw new Error("kind must be canvas or script");
    const target = this.artifacts.target(args.kind, args.name as string);
    const existing = await hosted.links.find(target);
    if ((target.kind === "canvas" && existing?.version_id) || (target.kind === "script" && existing?.script_hash)) {
      // Access changes must work even while the current draft is invalid. Keep
      // serving the already validated revision when renaming or restricting it.
      await hosted.links.set({ ...target, slug: args.slug as string, access: args.access as "private" | "public" | undefined });
      return text({ ok: true, ...await this.artifacts.linkDetails(target) });
    }
    await hosted.links.check(target, args.slug as string);
    const generation = await hosted.links.begin(target);
    const settings = { slug: args.slug as string, ...(args.access === undefined ? {} : { access: args.access as "private" | "public" }) };
    if (target.kind === "script") {
      const active = await hosted.scripts.active({ workspace: this.workspace, name: target.name });
      const link = await hosted.links.commit(target, generation, { ...settings, script_hash: active.hash });
      return link ? text({ ok: true, ...await this.artifacts.linkDetails(target) }) : text({ ok: false, superseded: true, error: "A newer update superseded this URL activation" }, true);
    }
    const snapshot = await this.snapshot({ name: target.name });
    const compiled = await this.compile(snapshot);
    if (!compiled.ok) return text({ ok: false, diagnostics: compiled.diagnostics, check: formatCanvasCheck(compiled.diagnostics) }, true);
    const { _meta, ...preview } = await this.preview(snapshot, compiled);
    if (preview.ok && "canvas" in preview) {
      const link = await hosted.links.commit(target, generation, { ...settings, version_id: preview.canvas.versionId });
      if (!link) return text({ ok: false, superseded: true, error: "A newer update superseded this URL activation" }, true);
    }
    return { ...text({ ...preview, ...await this.artifacts.linkDetails(target) }), ...(_meta ? { _meta } : {}) };
  }

  scriptReadSource(selection: { name?: string; version_id?: string }) {
    return this.scripts.readSource(selection);
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
        Object.assign(artifact, await this.artifacts.linkDetails({ libraryKey: this.libraryKey, workspace: artifact.workspace, name: artifact.name, kind: artifact.kind }));
      }
    }
    return { ...(this.hosted ? { capabilities: { scripts: true, links: true } } : {}), workspace: this.workspace, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: scriptsHaveMore || versions.length === 100 || drafts.length === 100 ? offset + 100 : null };
  }
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}
