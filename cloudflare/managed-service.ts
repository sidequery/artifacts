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

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
type Selection = { name?: string; version_id?: string; event_id?: string };

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
    if (["artifact_guide", "script_guide", "plugins_list", "plugin_guide", "artifact_plugin_call"].includes(name)) return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).callTool(name, args);
    const kind = name.startsWith("script_") ? "script" : name === "artifact_link" ? args.kind as "artifact" | "script" : "artifact";
    if (["artifact_list", "script_list", "artifact_history", "script_history"].includes(name)) {
      const history = name.endsWith("_history"), offset = args.offset as number | undefined ?? 0;
      const rows = await this.links.catalog({ libraryKey: this.libraryKey, workspace: this.workspace, kind, method: history ? "history" : "listDrafts", name: args.name as string | undefined, offset });
      if (!history) for (const row of rows) Object.assign(row, await this.linkDetails(kind, row.workspace, kind === "artifact" ? row.id! : row.name));
      return text({ [history ? "versions" : kind === "script" ? "scripts" : "artifacts"]: rows, next_offset: rows.length === 100 ? offset + 100 : null });
    }
    const selection = this.selection(kind, { name: args.name as string | undefined, version_id: args.version_id as string | undefined });
    const target = name.endsWith("_remix")
      ? await this.links.admitRemix(selection, args.new_name as string)
      : await this.links.admit(selection, name === "artifact_write" || name === "script_write");
    return this.physical(target).callTool(name, args);
  }

  pluginCall(request: PluginRequest) { return this.physical({ libraryKey: this.libraryKey, workspace: this.workspace }).pluginCall(request); }
  async snapshot(selection: Selection) { return (await this.service("artifact", selection)).snapshot(selection); }
  async scriptReadSource(selection: Selection) { return (await this.service("script", selection)).scriptReadSource(selection); }
  async request(selection: Selection, request: ArtifactHttpRequest) { return (await this.service("artifact", selection)).request(selection, request); }
  async fileRequest(selection: Selection, request: ArtifactFileRequest) { return (await this.service("artifact", selection)).fileRequest(selection, request); }
  async preview(snapshot: Awaited<ReturnType<CloudArtifactService["snapshot"]>>) {
    const selection = snapshot.version_id ? { version_id: snapshot.version_id, event_id: (snapshot as { event_id?: string | null }).event_id ?? undefined } : { name: snapshot.name };
    const service = await this.service("artifact", selection);
    // The gallery's snapshot and preview are separate calls. Re-read after fresh
    // ownership admission instead of reusing a possibly moved/recreated draft.
    return service.preview(await service.snapshot(selection));
  }

  private async linkDetails(kind: "artifact" | "script", workspace: string, name: string) {
    const target = await this.links.admit({ libraryKey: this.libraryKey, workspace, kind, name });
    const link = await this.links.find(target);
    if (link) return { slug: link.slug, access: link.access, url: `${this.publicOrigin}/${link.slug}` };
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
    for (const item of artifacts.values()) Object.assign(item, await this.linkDetails(item.kind!, item.workspace, item.name));
    return { capabilities: { scripts: true, links: true, moves: true }, workspace: this.workspace,
      artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), nextOffset: hasMore ? offset + 100 : null };
  }
}
