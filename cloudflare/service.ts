import type { DurableObjectStub } from "@cloudflare/workers-types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CanvasLibrary, CanvasEdit } from "./library";
import { compileCanvasSource, typecheckCanvasSource } from "./compiler";
import { formatCanvasCheck } from "../src/diagnostics";
import type { CanvasAppPayload } from "../src/mcpAppContract";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { runtime } from "../dist/cloudflare/identity.json";

type Snapshot = {
  workspace: string; name: string; path: string; source: string;
  state: Record<string, unknown>; version_id?: string | null;
};
type Mutation = Snapshot & { ok: boolean; applied?: boolean; changed?: boolean; restored?: boolean; source_hash?: string; edits_applied?: number; versionId?: string; revision?: number };
type Compiled = Awaited<ReturnType<typeof compileCanvasSource>>;

export class CloudCanvasService {
  constructor(readonly library: DurableObjectStub<CanvasLibrary>, readonly workspace: string) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case "canvas_list": {
        const offset = args.offset as number | undefined ?? 0;
        const canvases = await this.library.listDrafts({ workspace: this.workspace, offset });
        return text({ canvases, next_offset: canvases.length === 100 ? offset + 100 : null });
      }
      case "canvas_read": return text(await this.library.readRange({ workspace: this.workspace, name: args.name as string, start_line: args.start_line as number | undefined, end_line: args.end_line as number | undefined }));
      case "canvas_history": {
        const offset = args.offset as number | undefined ?? 0;
        const versions = await this.library.history({ workspace: this.workspace, name: args.name as string | undefined, offset });
        return text({ versions, next_offset: versions.length === 100 ? offset + 100 : null });
      }
      case "canvas_version": return text(await this.library.version({ workspace: this.workspace, id: args.version_id as string, events_offset: args.events_offset as number | undefined }));
      case "canvas_write": return this.mutationResult(await this.library.writeDraft({ workspace: this.workspace, name: args.name as string, source: args.contents as string }));
      case "canvas_edit": return this.mutationResult(await this.library.editDraft({ workspace: this.workspace, name: args.name as string, edits: args.edits as CanvasEdit[], expected_hash: args.expected_hash as string | undefined }));
      case "canvas_restore": return this.mutationResult(await this.library.restore({ workspace: this.workspace, id: args.version_id as string, runtime }));
      case "canvas_typecheck": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const diagnostics = typecheckCanvasSource(snapshot.source);
        return text({ path: snapshot.path, check: formatCanvasCheck(diagnostics), diagnostics }, diagnostics.length > 0);
      }
      case "canvas_compile": {
        const snapshot = await this.snapshot({ name: args.name as string });
        const compiled = await compileCanvasSource(snapshot.source);
        return text({ ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics, bytes: compiled.js?.length ?? 0 }, !compiled.ok);
      }
      case "canvas_open": {
        const snapshot = await this.snapshot(args as { name?: string; version_id?: string; event_id?: string });
        const preview = await this.preview(snapshot);
        const { _meta, ...payload } = preview;
        return { ...text(payload, !preview.ok), structuredContent: payload, ...(_meta ? { _meta } : {}) };
      }
      default: throw new Error("Unknown tool");
    }
  }

  snapshot(selection: { name?: string; version_id?: string; event_id?: string }): Promise<Snapshot> {
    return this.library.preview({ workspace: this.workspace, ...selection });
  }

  async preview(snapshot: Snapshot, compiled?: Compiled) {
    compiled ??= await compileCanvasSource(snapshot.source);
    const base = { ok: compiled.ok, path: snapshot.path, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok || !compiled.js) return { ...base, ok: false, _meta: undefined };
    const { version, event } = await this.library.recordServe({
      workspace: snapshot.workspace, name: snapshot.name, source: snapshot.source,
      runtime, initial_state: snapshot.state, mode: "preview",
      ...(snapshot.version_id ? { version_id: snapshot.version_id } : {}),
    });
    const canvas = { name: version.name, versionId: version.id, eventId: event.id, sourceHash: version.source_hash };
    return { ...base, ok: true, canvas, _meta: { canvas: { ...canvas, js: compiled.js, state: snapshot.state } satisfies CanvasAppPayload } };
  }

  private async mutationResult(mutation: Mutation): Promise<CallToolResult> {
    const { source, state, ...summary } = mutation;
    const compiled = await compileCanvasSource(source);
    const payload = { ...summary, applied: true, ok: compiled.ok, check: formatCanvasCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
    if (!compiled.ok) return { ...text(payload, true), structuredContent: payload };
    // The draft is already committed. A delivery error must never look like a
    // rollback, and compilation must use that exact committed source snapshot.
    try {
      const { _meta, ...details } = await this.preview(mutation, compiled);
      return { ...text(payload, !details.ok), structuredContent: { ...payload, preview: details }, ...(_meta ? { _meta } : {}) };
    } catch (error) {
      const failed = { ...payload, preview: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      return { ...text(failed, true), structuredContent: failed };
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
    return { workspace: this.workspace, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: versions.length === 100 || drafts.length === 100 ? offset + 100 : null };
  }
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}
