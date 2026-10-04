import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "./worker";
import type { ArtifactTarget } from "./links";
import type { LibrarySelection } from "./ownership";
import type { PluginInvocationContext } from "./plugins";
import type { PluginRequest } from "../src/plugins/types";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import type { ArtifactFileRequest } from "../src/sdk/files";
import type { GalleryArtifact, GalleryData } from "../src/gallery/types";
import { CloudArtifactService } from "./service";
import { workspaceTool } from "./workspace-tools";
import { parseProjectArchive } from "../src/project-archive";
import { ownershipName } from "./ownership";

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
type Selection = { workspace?: string; name?: string; version_id?: string; event_id?: string };

/** Management requests select an owner; execution continues on immutable storage. */
export class ManagedArtifactService {
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
    try { return await this.physical(target).callTool(name, { ...args, workspace: target.workspace }); }
    finally {
      // A failed compile may still have saved a draft. Resolve current ownership
      // after the operation, including writes admitted before a library move.
      if (changesGallery) await this.links.changed({ ...target,
        ...(name.endsWith("_remix") ? { name: ownershipName(target.kind, args.new_name) } : {}),
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
    if (["artifacts_library", "artifacts_working", "artifacts_search", "artifacts_mentions"].includes(name)) return workspaceTool(this, name, args);
    if (name === "artifacts_preview") name = "artifact_open";
    if (name.startsWith("app_")) return this.nativeTool(name, args);
    if (["artifact_guide", "script_guide", "plugins_list", "plugin_guide", "artifact_plugin_call"].includes(name)) return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).callTool(name, args);
    const kind = name.startsWith("script_") ? "script" : name === "artifact_link" ? args.kind as "artifact" | "script" : "artifact";
    if (["artifact_list", "script_list", "artifact_history", "script_history"].includes(name)) {
      const history = name.endsWith("_history"), offset = args.offset as number | undefined ?? 0;
      const rows = await this.links.catalog({ libraryKey: this.libraryKey, workspace: this.workspace, kind, method: history ? "history" : "listDrafts", name: args.name as string | undefined, offset });
      if (!history) for (const row of rows) Object.assign(row, await this.linkDetails(kind, row.workspace, kind === "artifact" ? row.id! : row.name));
      return text({ [history ? "versions" : kind === "script" ? "scripts" : "artifacts"]: rows, next_offset: rows.length === 100 ? offset + 100 : null });
    }
    const selection = this.selection(kind, { name: args.name as string | undefined, version_id: args.version_id as string | undefined, ...(typeof args.workspace === "string" ? { workspace: args.workspace } : {}) });
    if (name.endsWith("_import")) {
      parseProjectArchive(args.archive, kind);
      const target = await this.links.admit(this.selection(kind, { name: args.new_name as string }), true);
      return this.callSelectedTool(target, name, args);
    }
    const target = name.endsWith("_remix")
      ? await this.links.admitRemix(selection, args.new_name as string)
      : await this.links.admit(selection, name === "artifact_write" || name === "script_write");
    return this.callSelectedTool(target, name, args);
  }

  private nativeController() {
    if (!this.env.NATIVE_APPS) throw new Error("Native apps are not enabled on this deployment");
    return this.env.NATIVE_APPS.getByName("deployment");
  }
  private async nativeTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (tool === "app_guide") return text({ guide: "Native apps preserve the default Worker and named Durable Object exports. app_write accepts source, a strict app-owned manifest and optional project files/dependencies. Manifest fields: main (relative JS/TS path), compatibility_date, compatibility_flags, vars, secrets (names only), bindings (name -> {type:kv|r2|d1|queue|durable-object, resource:stable-name, class_name:DO export}), triggers:{crons:[],queues:[resource-name]}. Resource names permanently identify storage; binding/export renames preserve it and removed resources remain reserved. Set secrets with app_secrets. app_read/history/restore/reconcile manage persistent revisions and interrupted deployments. Restores retain current data and current secrets. Providers cannot change on an existing app. celld-local accepts trusted code only. URLs are private /apps/<name>/?workspace=<workspace>&library=<private|team>, require library authentication, stream HTTP and strip management credentials/cookies. Cloudflare uses native queue/cron delivery. celld-local operator does not support WebSockets. No destructive resource removal or schema/data rollback is provided." });
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
    if (["app_write", "app_restore", "app_reconcile", "app_move"].includes(tool) || (tool === "app_secrets" && args.secrets)) {
      await this.links.nativeAppChanged({ libraryKey: this.libraryKey, workspace: this.workspace });
      if (tool === "app_move") await this.links.nativeAppChanged({ libraryKey: args.library === "team" ? "team" : this.privateKey, workspace: this.workspace });
    }
    const failed = payload.ok === false || (payload.deployment as { ok?: boolean } | undefined)?.ok === false;
    return { ...text(result), structuredContent: payload, isError: failed };
  }
  nativeFetch(name: string, request: Request) {
    const headers = new Headers(request.headers);
    headers.set("x-artifacts-app-selection", JSON.stringify({ owner: this.libraryKey, workspace: this.workspace, name }));
    return this.nativeController().fetch(new Request(request, { headers }));
  }

  pluginCall(request: PluginRequest) { return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).pluginCall(request); }
  async snapshot(selection: Selection) { return (await this.service("artifact", selection)).snapshot(selection); }
  async scriptReadSource(selection: Selection) { return (await this.service("script", selection)).scriptReadSource(selection); }
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
          const item: GalleryArtifact = artifacts.get(key) ?? { key, name, workspace: row.workspace, working: false, kind, versions: [] };
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
    return { capabilities: { scripts: true, links: true, moves: true, nativeApps: !!this.env.NATIVE_APPS, subscriptions: true }, workspace: this.workspace,
      ...(workers ? { workerApps: workers.apps.map(app => ({ ...app, kind: "worker" as const, key: JSON.stringify(["worker", app.workspace, app.name]) })), nativeAppProviders: workers.providers } : {}),
      artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: hasMore ? offset + 100 : null };
  }
}
