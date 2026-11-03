import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "./worker";
import { nativeLinkTarget, type ArtifactTarget } from "./links";
import type { LibrarySelection } from "./ownership";
import type { PluginInvocationContext } from "./plugins";
import type { PluginRequest } from "../src/plugins/types";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import type { ArtifactFileRequest } from "../src/sdk/files";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { CloudArtifactService } from "./service";
import { workspaceTool } from "./workspace-tools";
import { galleryAction, gallerySource } from "./gallery-tools";
import { ARTIFACTS_SETTINGS_TOOLS, settingsTool } from "../src/mcp/settings-contract";
import { parseProjectArchive, projectArchive } from "../src/project-archive";
import { ownershipName } from "./ownership";
import { callDiscoveryTool, isDiscoveryTool } from "../src/mcp/discovery";
import { validateToolArguments } from "../src/mcp/validation";
import { CLOUD_MCP_TOOLS } from "./tool-contract";
import * as toolValidators from "../dist/cloudflare/tool-validators.js";

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
type Selection = { workspace?: string; name?: string; version_id?: string; event_id?: string; library_scope?: "private" | "team" };
// Artifact operations a legacy script can still serve; null operations need a UI.
const LEGACY_SCRIPT_TOOLS: Record<string, string | null> = {
  artifact_read: "script_read", artifact_edit: "script_edit", artifact_write: "script_write", artifact_version: "script_version",
  artifact_restore: "script_restore", artifact_export: "script_export", artifact_secrets: "script_secrets", artifact_schedule: "script_schedule",
  artifact_runs: "script_runs", artifact_logs: "script_logs", artifact_request: "script_run",
  artifact_open: null, artifacts_preview: null, artifact_typecheck: null, artifact_compile: null, artifact_files: null,
};

/** Management requests select an owner; execution continues on immutable storage. */
export class ManagedArtifactService {
  get productUrl() {
    const url = new URL("/", this.origin);
    url.searchParams.set("workspace", this.workspace);
    if (this.libraryKey === "team") url.searchParams.set("library", "team");
    return url.href;
  }
  readonly fileStorage;
  private readonly links;
  constructor(private readonly env: Env, readonly workspace: string, readonly libraryKey: string,
    private readonly privateKey: string, private readonly origin: string, private readonly publicOrigin: string,
    private readonly plugins: PluginInvocationContext) {
    this.links = env.LINKS.getByName("deployment");
    this.fileStorage = env.FILE_BACKENDS ? { backends: env.FILE_BACKENDS, origin: publicOrigin } : undefined;
  }

  private physical(target: Pick<ArtifactTarget, "libraryKey" | "workspace">) {
    return new CloudArtifactService(this.env.LIBRARIES.getByName(target.libraryKey), target.workspace, this.env.BACKENDS, target.libraryKey,
      { links: this.links, scripts: this.env.SCRIPTS.getByName(target.libraryKey), scriptBackends: this.env.SCRIPT_BACKENDS, origin: this.origin, publicOrigin: this.publicOrigin },
      this.plugins, this.fileStorage);
  }

  private scoped(scope: unknown): ManagedArtifactService {
    if (scope === undefined) return this;
    if (scope !== "private" && scope !== "team") throw new Error("Library scope must be private or team");
    if (scope === "private" && this.privateKey === "team") throw new Error("Service tokens manage the team library only");
    const libraryKey = scope === "team" ? "team" : this.privateKey;
    return libraryKey === this.libraryKey ? this : new ManagedArtifactService(this.env, this.workspace, libraryKey,
      this.privateKey, this.origin, this.publicOrigin, this.plugins);
  }

  private selection(kind: "artifact" | "script", selection: Selection): LibrarySelection {
    return { libraryKey: this.libraryKey, workspace: this.workspace, kind, ...selection };
  }

  subscribeGallery(all: boolean) {
    return this.links.fetch(new Request("https://gallery.internal/subscribe", { headers: {
      Upgrade: "websocket",
      "x-gallery-selection": JSON.stringify({ libraryKey: this.libraryKey, ...(all ? {} : { workspace: this.workspace }) }),
    } }));
  }

  private async callSelectedTool(target: ArtifactTarget, name: string, args: Record<string, unknown>) {
    const changesGallery = /^(artifact|script)_(write|edit|restore|remix|import|open|link)$/.test(name);
    try {
      const result = await this.physical(target).callTool(name, { ...args, workspace: target.workspace });
      const scope = this.libraryKey === "team" ? "team" : "private";
      // Both full previews and compact mutation results must reopen in the
      // logical library, even after an item moves to different physical storage.
      const scopedArtifact = (value: unknown) => value && typeof value === "object" ? { ...value, library_scope: scope } : value;
      if (result._meta?.artifact) result._meta = { ...result._meta, artifact: scopedArtifact(result._meta.artifact) };
      const content = result.structuredContent;
      if (content) {
        const preview = content.preview as Record<string, unknown> | undefined;
        result.structuredContent = { ...content,
          ...(content.artifact ? { artifact: scopedArtifact(content.artifact) } : {}),
          ...(content.appPreview ? { appPreview: scopedArtifact(content.appPreview) } : {}),
          ...(preview?.artifact ? { preview: { ...preview, artifact: scopedArtifact(preview.artifact) } } : {}),
        };
      }
      return result;
    }
    finally {
      // A failed compile may still have saved a draft. Resolve current ownership
      // after the operation, including writes admitted before a library move.
      if (changesGallery) await this.links.changed({ ...target,
        ...(name.endsWith("_remix") ? { name: ownershipName(target.kind === "script" ? "script" : "artifact", args.new_name) } : {}),
      });
    }
  }

  private async service(kind: "artifact" | "script", selection: Selection) {
    return this.physical(await this.links.admit(this.selection(kind, selection)));
  }

  async move(input: { kind: "artifact" | "script"; name: string; library: "private" | "team" }) {
    if (input.kind !== "artifact" && input.kind !== "script") throw new Error("kind must be artifact or script");
    if (input.library !== "private" && input.library !== "team") throw new Error("Library must be private or team");
    const moved = await this.links.move({ ...this.selection(input.kind, { name: input.name }), name: input.name }, input.library === "team" ? "team" : this.privateKey);
    return { ok: true, ...moved, libraryScope: input.library };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (args.library_scope !== undefined) {
      const { library_scope, ...input } = args;
      return this.scoped(library_scope).callTool(name, input);
    }
    if (isDiscoveryTool(name)) {
      return callDiscoveryTool(CLOUD_MCP_TOOLS, name, args, async (operation, input) => {
        validateToolArguments(toolValidators, operation, input);
        // Re-enter management admission, not the physical storage service: moved
        // revisions and native apps still resolve the authenticated owner here.
        return this.callTool(operation, input);
      });
    }
    if (ARTIFACTS_SETTINGS_TOOLS.some(tool => tool.name === name)) return settingsTool(this, name, args);
    if (name === "artifacts_trash") {
      const items = await this.links.trash({ libraryKey: this.libraryKey, workspace: args.all === true ? undefined : this.workspace, offset: args.offset as number | undefined });
      return text({ items, next_offset: items.length === 100 ? (args.offset as number | undefined ?? 0) + 100 : null });
    }
    if (/^(artifact|script)_(delete|undelete)$/.test(name)) {
      const kind = name.startsWith("script_") ? "script" : "artifact";
      const result = await this.links.setTrashed({ ...this.selection(kind, {
        name: args.name as string, ...(typeof args.workspace === "string" ? { workspace: args.workspace } : {}),
      }), name: args.name as string }, name.endsWith("_delete"));
      return text({ ok: true, ...result });
    }
    if (name === "artifacts_tool") return galleryAction(this, args);
    if (name === "artifacts_source") return gallerySource(this, args);
    if (["artifacts_library", "artifacts_working", "artifacts_search", "artifacts_mentions"].includes(name)) return workspaceTool(this, name, args);
    if (name === "artifacts_preview") {
      // Hosts may strip _meta before the MCP App sees it; mirror the preview payload.
      const opened = await this.callTool("artifact_open", args);
      const artifact = opened._meta?.artifact;
      return artifact ? { ...opened, structuredContent: { ...opened.structuredContent, appPreview: artifact } } : opened;
    }
    if (name.startsWith("app_")) return this.nativeTool(name, args);
    if (name === "artifact_link" && args.kind === "app") return this.linkNativeApp(args);
    if (["artifact_guide", "script_guide", "plugins_list", "plugin_guide", "artifact_plugin_call"].includes(name)) return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).callTool(name, args);
    const kind = name.startsWith("script_") ? "script" : name === "artifact_link" ? args.kind as "artifact" | "script" : "artifact";
    if (name === "artifact_list") {
      // Legacy scripts are server-only artifacts to callers; page both stores together.
      const offset = args.offset as number | undefined ?? 0;
      const [artifacts, scripts] = await Promise.all((["artifact", "script"] as const).map(async kind => {
        const rows = await this.links.catalog({ libraryKey: this.libraryKey, workspace: this.workspace, kind, method: "listDrafts", offset });
        for (const row of rows) Object.assign(row, await this.linkDetails(kind, row.workspace, kind === "artifact" ? row.id! : row.name));
        return rows;
      }));
      return text({ artifacts, legacy_scripts: scripts, next_offset: artifacts!.length === 100 || scripts!.length === 100 ? offset + 100 : null });
    }
    if (["script_list", "artifact_history", "script_history"].includes(name)) {
      const history = name.endsWith("_history"), offset = args.offset as number | undefined ?? 0;
      const rows = await this.links.catalog({ libraryKey: this.libraryKey, workspace: this.workspace, kind, method: history ? "history" : "listDrafts", name: args.name as string | undefined, offset });
      if (name === "artifact_history" && args.name !== undefined && rows.length === 0 && offset === 0 && await this.legacyScriptExists({ name: args.name as string })) return this.callTool("script_history", args);
      if (!history) for (const row of rows) Object.assign(row, await this.linkDetails(kind, row.workspace, kind === "artifact" ? row.id! : row.name));
      return text({ [history ? "versions" : kind === "script" ? "scripts" : "artifacts"]: rows, next_offset: rows.length === 100 ? offset + 100 : null });
    }
    const workspace = typeof args.workspace === "string" ? { workspace: args.workspace } : {};
    if (name === "artifact_write" && await this.legacyScriptExists({ name: args.name as string, ...workspace }) && !await this.itemExists("artifact", { name: args.name as string, ...workspace })) {
      if (typeof args.contents === "string") throw new Error(`${String(args.name)} is a legacy script, which cannot have a UI. Use artifact_remix to copy it into a new artifact first.`);
      return this.legacyScriptTool(name, args);
    }
    if ((name === "artifact_import" || name === "artifact_remix") && await this.legacyScriptExists({ name: args.new_name as string, ...workspace })) {
      throw new Error(`${String(args.new_name)} is already used by a legacy script; choose a new name`);
    }
    if (name === "artifact_remix" && !await this.itemExists("artifact", { name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...workspace })
      && await this.legacyScriptExists({ name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...workspace })) {
      return this.remixLegacyScript(args);
    }
    if (name === "artifact_import" && (args.archive as { kind?: unknown } | undefined)?.kind === "script") {
      const archive = parseProjectArchive(args.archive, "script");
      return this.callTool(name, { ...args, archive: { ...archive, kind: "artifact", source: "", server_source: archive.source } });
    }
    if (name in LEGACY_SCRIPT_TOOLS && name !== "artifact_write") {
      try { return await this.callArtifactTool(kind, name, args); }
      catch (error) {
        if (!(error instanceof Error) || !/(artifact|version|item) not found/.test(error.message)) throw error;
        if (!await this.legacyScriptExists({ name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...workspace })) throw error;
        return this.legacyScriptTool(name, args);
      }
    }
    return this.callArtifactTool(kind, name, args);
  }

  private async callArtifactTool(kind: "artifact" | "script", name: string, args: Record<string, unknown>) {
    const selection = this.selection(kind, { name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...(typeof args.workspace === "string" ? { workspace: args.workspace } : {}) });
    if (name.endsWith("_import")) {
      parseProjectArchive(args.archive, kind);
      const target = await this.links.admit(this.selection(kind, { name: args.new_name as string, ...(typeof args.workspace === "string" ? { workspace: args.workspace } : {}) }), true);
      return this.callSelectedTool(target, name, args);
    }
    const target = name.endsWith("_remix")
      ? await this.links.admitRemix(selection, args.new_name as string)
      : await this.links.admit(selection, name === "artifact_write" || name === "script_write");
    return this.callSelectedTool(target, name, args);
  }

  private async itemExists(kind: "artifact" | "script", selection: Selection): Promise<boolean> {
    if (selection.name === undefined && selection.version_id === undefined) return false;
    try {
      const target = await this.links.admit(this.selection(kind, selection));
      if (selection.version_id !== undefined) return true;
      const library = kind === "artifact" ? this.env.LIBRARIES.getByName(target.libraryKey) : this.env.SCRIPTS.getByName(target.libraryKey);
      await library.readRange({ workspace: target.workspace, name: target.name, end_line: 1 });
      return true;
    } catch (error) {
      if (error instanceof Error && /not found|invalid name|name is required/.test(error.message)) return false;
      throw error;
    }
  }
  private legacyScriptExists(selection: Selection) { return this.itemExists("script", selection); }

  /** Serves an artifact_* call from a script saved before scripts became server-only artifacts. */
  private async legacyScriptTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = LEGACY_SCRIPT_TOOLS[name];
    const label = String(args.name ?? args.version_id);
    if (!tool) throw new Error(`${label} is a legacy script without a UI, so ${name} does not apply. Use artifact_request, or artifact_remix it into an artifact.`);
    const { part, preview: _preview, contents: _contents, server, events_offset: _events, ...scriptArgs } = args;
    if (part === "client") throw new Error(`${label} is a legacy script and has no browser source`);
    const workspace = typeof args.workspace === "string" ? { workspace: args.workspace } : {};
    if (name === "artifact_write") {
      if (typeof server !== "string") throw new Error(`${label} is a legacy script: pass its source as server, or artifact_remix it into an artifact to add a UI`);
      scriptArgs.contents = server;
    }
    if (name === "artifact_restore") scriptArgs.name = (await this.links.admit(this.selection("script", { version_id: args.version_id as string, ...workspace }))).name;
    if (name === "artifact_request") {
      if (typeof args.name !== "string") throw new Error("Select a legacy script by name");
      // Legacy handlers see the full deployment path; artifact paths are relative to the item URL.
      const link = await this.links.find(await this.links.admit(this.selection("script", { name: args.name, ...workspace })));
      const request = args.request as ArtifactHttpRequest;
      const suffix = request.path === "/" || request.path.startsWith("/?") ? request.path.slice(1) : request.path;
      if (link) scriptArgs.request = { ...request, path: `/${link.slug}${suffix}` };
    }
    return this.callTool(tool, scriptArgs);
  }

  /** Remixing a legacy script creates a server-only artifact with fresh data. */
  private async remixLegacyScript(args: Record<string, unknown>): Promise<CallToolResult> {
    const workspace = typeof args.workspace === "string" ? { workspace: args.workspace } : {};
    const source = await this.scriptReadSource({ name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...workspace });
    const archive = projectArchive("artifact", { name: source.name, source: "", server_source: source.source, project: source.project });
    const result = await this.callTool("artifact_import", { ...workspace, new_name: args.new_name, archive, ...(args.slug === undefined ? {} : { slug: args.slug }), ...(args.preview === undefined ? {} : { preview: args.preview }) });
    result.content.push({ type: "text", text: `Created server-only artifact ${String(args.new_name)} from legacy script ${source.name}. Its handler now receives paths relative to the artifact URL, and its storage, secrets and schedule start empty.` });
    return result;
  }

  private nativeController() {
    if (!this.env.NATIVE_APPS) throw new Error("Native apps are not enabled on this deployment");
    return this.env.NATIVE_APPS.getByName("deployment");
  }
  private async nativeTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (tool === "app_guide") return text({ guide: "Native apps preserve the default Worker and named Durable Object exports. app_write accepts source, a strict app-owned manifest and optional project files/dependencies. Manifest fields: main (relative JS/TS path), compatibility_date, compatibility_flags, vars, secrets (names only), bindings (name -> {type:kv|r2|d1|queue|durable-object, resource:stable-name, class_name:DO export}), triggers:{crons:[],queues:[resource-name]}. Resource names permanently identify storage; binding/export renames preserve it and removed resources remain reserved. Set secrets with app_secrets. app_read/history/restore/reconcile manage persistent revisions and interrupted deployments. Restores retain current data and current secrets. Providers cannot change on an existing app. celld-local and celld-fleet accept trusted code only; celld-fleet uses the existing bucket-backed fleet and its coordinated publisher. Management URLs are private /apps/<name>/?workspace=<workspace>&library=<private|team> and require library authentication. artifact_link({kind:'app',name,slug,access}) adds a root /<slug> URL, private or public, that follows the app across library moves and passes slug-relative paths. Both stream HTTP and strip management credentials/cookies. Cloudflare uses native queue/cron delivery. celld-fleet uses native queues and host-coordinated cron dispatch into each app's own environment. celld-local operator does not support WebSockets. No destructive resource removal or schema/data rollback is provided." });
    const controller = this.nativeController(), input = { owner: this.libraryKey, workspace: this.workspace, name: args.name as string };
    let result: unknown;
    switch (tool) {
      case "app_list": result = await controller.list({ owner: this.libraryKey, workspace: this.workspace, offset: args.offset as number | undefined }); break;
      case "app_read": result = await controller.read({ ...input, revision_id: args.revision_id as string | undefined }); break;
      case "app_history": result = await controller.history({ ...input, offset: args.offset as number | undefined }); break;
      case "app_write": result = await controller.write({ ...input, source: args.source as string, manifest: args.manifest, project: args.project, provider: args.provider as string | undefined, expected_revision: args.expected_revision as string | null | undefined }); break;
      case "app_restore": result = await controller.restore({ ...input, revision_id: args.revision_id as string }); break;
      case "app_reconcile": result = await controller.reconcile(input); break;
      case "app_secrets": result = await controller.secrets({ ...input, secrets: args.secrets as Record<string, string | null> | undefined }); break;
      case "app_move": {
        if (args.library !== "private" && args.library !== "team") throw new Error("Library must be private or team");
        result = await controller.move({ ...input, destination: args.library === "team" ? "team" : this.privateKey }); break;
      }
      default: throw new Error("Unknown app tool");
    }
    const payload = result as Record<string, unknown>;
    if (tool === "app_read" || (tool === "app_write" && typeof payload.id === "string")) Object.assign(payload, await this.nativeLinkDetails(this.workspace, payload.id as string));
    if (tool === "app_list") for (const app of payload.apps as { id: string; workspace: string }[]) Object.assign(app, await this.nativeLinkDetails(app.workspace, app.id));
    if (["app_write", "app_restore", "app_reconcile", "app_move"].includes(tool) || (tool === "app_secrets" && args.secrets)) {
      await this.links.nativeAppChanged({ libraryKey: this.libraryKey, workspace: this.workspace });
      if (tool === "app_move") await this.links.nativeAppChanged({ libraryKey: args.library === "team" ? "team" : this.privateKey, workspace: this.workspace });
    }
    const failed = payload.ok === false || (payload.deployment as { ok?: boolean } | undefined)?.ok === false;
    return { ...text(result), structuredContent: payload, isError: failed };
  }
  private async linkNativeApp(args: Record<string, unknown>): Promise<CallToolResult> {
    const { id } = await this.nativeController().identity({ owner: this.libraryKey, workspace: this.workspace, name: args.name as string });
    await this.links.set({ ...nativeLinkTarget(this.workspace, id), slug: args.slug as string, access: args.access as "private" | "public" | undefined });
    await this.links.nativeAppChanged({ libraryKey: this.libraryKey, workspace: this.workspace });
    return text({ ok: true, ...await this.nativeLinkDetails(this.workspace, id) });
  }
  private async nativeLinkDetails(workspace: string, id: string) {
    const link = await this.links.find(nativeLinkTarget(workspace, id));
    return link ? { slug: link.slug, access: link.access, url: `${this.publicOrigin}/${link.slug}` } : {};
  }
  nativeFetch(name: string, request: Request) {
    const headers = new Headers(request.headers);
    headers.set("x-artifacts-app-selection", JSON.stringify({ owner: this.libraryKey, workspace: this.workspace, name }));
    return this.nativeController().fetch(new Request(request, { headers }));
  }

  pluginCall(request: PluginRequest) { return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).pluginCall(request); }
  async snapshot(selection: Selection) {
    const { library_scope, ...input } = selection;
    return (await this.scoped(library_scope).service("artifact", input)).snapshot(input);
  }
  async scriptReadSource(selection: Selection) {
    const { library_scope, ...input } = selection;
    return (await this.scoped(library_scope).service("script", input)).scriptReadSource(input);
  }
  async request(selection: Selection, request: ArtifactHttpRequest) { return (await this.service("artifact", selection)).request(selection, request); }
  async fileRequest(selection: Selection, request: ArtifactFileRequest) { return (await this.service("artifact", selection)).fileRequest(selection, request); }
  async preview(snapshot: Awaited<ReturnType<CloudArtifactService["snapshot"]>>) {
    const selection = snapshot.version_id ? { workspace: snapshot.workspace, version_id: snapshot.version_id, event_id: (snapshot as { event_id?: string | null }).event_id ?? undefined } : { workspace: snapshot.workspace, name: snapshot.name };
    const service = await this.service("artifact", selection);
    // The gallery's snapshot and preview are separate calls. Re-read after fresh
    // ownership admission instead of reusing a possibly moved/recreated draft.
    return service.preview(await service.snapshot(selection));
  }

  private async linkDetails(kind: "artifact" | "script", workspace: string, name: string) {
    const target = await this.links.admit({ libraryKey: this.libraryKey, workspace, kind, name });
    const link = await this.links.find(target);
    if (link) return { slug: link.slug, access: link.access, url: `${this.publicOrigin}/${link.slug}`, live: link.live, liveId: link.version_id ?? link.script_hash };
    const pending = await this.links.draft(target);
    return pending.slug ? { slug: pending.slug, access: pending.access ?? "private" } : {};
  }

  async gallery(all: boolean, offset = 0): Promise<GalleryData> {
    const artifacts = new Map<string, GalleryArtifact>();
    let hasMore = false;
    for (const kind of ["artifact", "script"] as const) {
      for (const method of ["history", "listDrafts"] as const) {
        const rows = await this.links.catalog({ libraryKey: this.libraryKey, workspace: all ? undefined : this.workspace, kind, method, offset });
        hasMore ||= rows.length === 100;
        for (const row of rows) {
          const name = method === "listDrafts" && kind === "artifact" ? row.id! : row.name;
          const key = JSON.stringify(kind === "script" ? ["script", row.workspace, name] : [row.workspace, name]);
          const item: GalleryArtifact = artifacts.get(key) ?? { key, name, workspace: row.workspace, library_scope: this.libraryKey === "team" ? "team" : "private", working: false, kind, versions: [] };
          if (row.server_only) item.serverOnly = true;
          if (method === "listDrafts") item.working = true;
          else item.versions.push({ id: row.version_id ?? row.id!, revision: row.revision as number, createdAt: row.created_at!, reason: row.reason as string, serveCount: kind === "artifact" ? row.serve_count as number : 0 });
          artifacts.set(key, item);
        }
      }
    }
    for (const item of artifacts.values()) {
      Object.assign(item, await this.linkDetails(item.kind!, item.workspace, item.name));
      if (item.working) {
        const target = await this.links.admit({ libraryKey: this.libraryKey, workspace: item.workspace, kind: item.kind!, name: item.name });
        item.draftRevision = item.kind === "script"
          ? await this.env.SCRIPTS.getByName(target.libraryKey).draftRevision({ workspace: item.workspace, name: item.name })
          : await this.env.LIBRARIES.getByName(target.libraryKey).draftRevision({ workspace: item.workspace, name: item.name });
      }
    }
    const workers = this.env.NATIVE_APPS
      ? await this.nativeController().list({ owner: this.libraryKey, workspace: all ? undefined : this.workspace, offset })
      : null;
    hasMore ||= workers?.next_offset != null;
    return { libraryScope: this.libraryKey === "team" ? "team" : "private", capabilities: { editing: true, scripts: true, links: true, moves: true, trash: true, nativeApps: !!this.env.NATIVE_APPS, subscriptions: true, subscriptionTransport: "events" as const }, workspace: this.workspace,
      ...(workers ? { workerApps: await Promise.all(workers.apps.map(async app => ({ ...app, ...await this.nativeLinkDetails(app.workspace, app.id), kind: "worker" as const, key: JSON.stringify(["worker", app.workspace, app.name]) }))), nativeAppProviders: workers.providers } : {}),
      artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: hasMore ? offset + 100 : null };
  }
}
