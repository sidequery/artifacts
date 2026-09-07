import type { DurableObjectStub, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CanvasLibrary, CanvasEdit } from "./library";
import { compileCanvasSource, compileCanvasServerSource, typecheckCanvasSource, typecheckCanvasServerSource } from "./compiler";
import type { CanvasBackend } from "./backend";
import type { LinkUpdate } from "./links";
import { ArtifactService, type HostedArtifacts } from "./artifact-service";
import { CloudScriptService } from "./script-service";
import { HOSTED_SCRIPT_GUIDE } from "./script-guide";
export type { HostedArtifacts } from "./artifact-service";
import type { CanvasHttpRequest } from "../src/httpTypes";
import { createHash } from "node:crypto";
import { formatCanvasCheck } from "../src/diagnostics";
import type { CanvasAppPayload } from "../src/mcp/app-contract";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { runtime } from "../dist/cloudflare/identity.json";
import { canvasGuideResult } from "../src/mcp/guide";

type Snapshot = {
  workspace: string; name: string; path: string; source: string;
  server_source: string | null;
  state: Record<string, unknown>; version_id?: string | null;
};
type Mutation = Snapshot & { ok: boolean; applied?: boolean; changed?: boolean; restored?: boolean; source_hash?: string; edits_applied?: number; versionId?: string; revision?: number };
type Compiled = Awaited<ReturnType<typeof compileCanvasSource>>;

export class CloudCanvasService {
  private readonly artifacts: ArtifactService;
  private readonly scripts: CloudScriptService;

  constructor(readonly library: DurableObjectStub<CanvasLibrary>, readonly workspace: string,
    readonly backends: DurableObjectNamespace<CanvasBackend>, readonly libraryKey: string, readonly hosted?: HostedArtifacts) {
    this.artifacts = new ArtifactService(workspace, libraryKey, hosted);
    this.scripts = new CloudScriptService(this.artifacts);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name.startsWith("script_")) return this.scripts.callTool(name, args);
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
        const entries = await Promise.all(canvases.map(async canvas => ({ ...canvas, ...await this.artifacts.linkDetails(this.artifacts.target("canvas", canvas.id)) })));
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
        const target = this.artifacts.target("canvas", args.name as string);
        if (args.slug !== undefined) await this.artifacts.requireHosted().links.check(target, args.slug as string);
        const generation = await this.hosted?.links.begin(target);
        return this.mutationResult(await this.library.writeDraft({ workspace: this.workspace, name: args.name as string, source: args.contents as string, server_source: args.server as string | null | undefined }), generation, { ...(args.slug === undefined ? {} : { slug: args.slug as string }), ...(args.access === undefined ? {} : { access: args.access as "private" | "public" }) });
      }
      case "canvas_edit": {
        const generation = await this.hosted?.links.begin(this.artifacts.target("canvas", args.name as string));
        return this.mutationResult(await this.library.editDraft({ workspace: this.workspace, name: args.name as string, part: args.part as "client" | "server" | undefined, edits: args.edits as CanvasEdit[], expected_hash: args.expected_hash as string | undefined }), generation);
      }
      case "canvas_restore": {
        const version = await this.library.version({ workspace: this.workspace, id: args.version_id as string });
        const generation = await this.hosted?.links.begin(this.artifacts.target("canvas", version.name));
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
    const base = { ...await this.artifacts.linkDetails(this.artifacts.target("canvas", snapshot.name)), ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
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
    const target = this.artifacts.target("canvas", mutation.name);
    if (generation != null) {
      await this.hosted!.links.stage(target, generation, settings);
      settings = { ...await this.hosted!.links.draft(target), ...settings };
    }
    const compiled = await this.compile(mutation);
    const payload = { ...summary, ...await this.artifacts.linkDetails(this.artifacts.target("canvas", mutation.name)), applied: true, ok: compiled.ok, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok) return { ...text(payload, true), structuredContent: payload };
    // The draft is already committed. A delivery error must never look like a
    // rollback, and compilation must use that exact committed source snapshot.
    try {
      const { _meta, ...details } = await this.preview(mutation, compiled);
      const target = this.artifacts.target("canvas", mutation.name);
      if (generation != null && details.ok && "canvas" in details && (settings.slug !== undefined || await this.hosted!.links.find(target))) {
        const link = await this.hosted!.links.commit(target, generation, { ...settings, version_id: details.canvas.versionId });
        if (!link) {
          const superseded = { ...payload, ok: false, superseded: true, error: "A newer update superseded this URL activation" };
          return { ...text(superseded, true), structuredContent: superseded };
        }
      }
      const result = { ...payload, ...await this.artifacts.linkDetails(target) };
      return { ...text(result, !details.ok), structuredContent: { ...result, preview: { ...details, ...await this.artifacts.linkDetails(target) } }, ...(_meta ? { _meta } : {}) };
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
