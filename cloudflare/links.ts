import { DurableObject } from "cloudflare:workers";
import { LibraryOwnership, type LibrarySelection, type OwnershipEnvironment } from "./ownership";
import { GallerySubscriptions } from "./gallery-subscriptions";
import type { ArtifactBackend } from "./backend";
import type { ScriptBackend } from "./script-backend";
import type { ArtifactFiles } from "./files";

type TrashEnvironment = { BACKENDS?: DurableObjectNamespace<ArtifactBackend>; SCRIPT_BACKENDS?: DurableObjectNamespace<ScriptBackend>; FILE_BACKENDS?: DurableObjectNamespace<ArtifactFiles> };

export type ArtifactTarget = { libraryKey: string; workspace: string; kind: "artifact" | "script"; name: string };
export type LiveRevision = { id: string; revision: number; revision_token: string };
export type LinkUpdate = { slug?: string; access?: "private" | "public"; version_id?: string; script_hash?: string; live?: LiveRevision };
export type ArtifactLink = ArtifactTarget & LinkUpdate & { slug: string; access: "private" | "public"; generation: number };
const reserved = new Set(["api", "mcp", "gallery", "health", "sign-in", "consent"]);
export function validateSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value) || reserved.has(value)) {
    throw new Error("Slug must be 1–80 lowercase letters, numbers or hyphens and must not be a reserved application route");
  }
  return value;
}
// Persist the original kind in keys so links, pending writes, and generations share their existing identity.
function key(target: ArtifactTarget) { return JSON.stringify([target.libraryKey, target.workspace, target.kind === "artifact" ? "canvas" : target.kind, target.name]); }
function readLink(value: string): ArtifactLink {
  const link = JSON.parse(value);
  if (link.kind === "canvas") link.kind = "artifact";
  return link;
}
/** Deployment-wide names; ownership is resolved before accessing any library. */
export class ArtifactLinks extends DurableObject<unknown> {
  private readonly ownership: LibraryOwnership;
  private readonly subscriptions: GallerySubscriptions;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ownership = new LibraryOwnership(ctx.storage.sql, env as OwnershipEnvironment);
    this.subscriptions = new GallerySubscriptions(ctx);
    ctx.storage.sql.exec("create table if not exists links (slug text primary key, target text not null unique, value text not null)");
    ctx.storage.sql.exec("create table if not exists generations (target text primary key, generation integer not null)");
    ctx.storage.sql.exec("create table if not exists pending_links (target text primary key, value text not null)");
  }
  owner(target: ArtifactTarget) { return this.ownership.owner(target); }
  admit(selection: LibrarySelection, create = false) { return this.ownership.admit(selection, create); }
  admitRemix(selection: LibrarySelection, newName: string) { return this.ownership.admitRemix(selection, newName); }
  async move(selection: LibrarySelection & { name: string }, destination: string) {
    const result = await this.ownership.move(selection, destination);
    this.subscriptions.changed(selection.libraryKey, result.workspace);
    this.subscriptions.changed(destination, result.workspace);
    return result;
  }
  catalog(input: Parameters<LibraryOwnership["catalog"]>[0]) { return this.ownership.catalog(input); }
  trash(input: Parameters<LibraryOwnership["trash"]>[0]) { return this.ownership.trash(input); }
  async setTrashed(selection: LibrarySelection & { name: string }, trashed: boolean) {
    const target = await this.ownership.setTrashed(selection, trashed, async (target, value) => {
      // Invalidate compiles admitted before deletion, including ones that finish
      // after the item is restored. Source and storage remain recoverable.
      if (value) this.beginGeneration(target);
      const env = this.env as TrashEnvironment;
      const backends = target.kind === "artifact" ? env.BACKENDS : env.SCRIPT_BACKENDS;
      const identity = JSON.stringify([target.libraryKey, target.workspace, target.name]);
      if (backends) await backends.getByName(identity).setTrashed(value);
      if (target.kind === "artifact" && env.FILE_BACKENDS) await env.FILE_BACKENDS.getByName(identity).setTrashed(value);
    });
    this.subscriptions.changed(selection.libraryKey, target.workspace);
    return { workspace: target.workspace, kind: target.kind, name: target.name, trashed };
  }
  fetch(request: Request) { return this.subscriptions.accept(request); }
  changed(target: ArtifactTarget) { this.subscriptions.changed(this.ownership.owner(target), target.workspace); }
  nativeAppChanged(selection: { libraryKey: string; workspace: string }) { this.subscriptions.changed(selection.libraryKey, selection.workspace); }
  webSocketMessage(socket: WebSocket) { socket.close(1008, "Receive-only subscription"); }
  webSocketClose(socket: WebSocket, code: number, reason: string) { socket.close(code, reason); }
  webSocketError(socket: WebSocket) { socket.close(1011, "Subscription disconnected"); }

  get(slug: string): ArtifactLink | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from links where slug = ?", slug).toArray()[0];
    const link = row ? readLink(row.value) : null;
    return link && !this.ownership.isTrashed(link) ? link : null;
  }
  find(target: ArtifactTarget): ArtifactLink | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from links where target = ?", key(target)).toArray()[0];
    return row && !this.ownership.isTrashed(target) ? readLink(row.value) : null;
  }
  check(target: ArtifactTarget, candidate: string): string {
    const slug = validateSlug(candidate);
    // Trashed links reserve their slug so restoring cannot hijack another URL.
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from links where slug=?", slug).toArray()[0];
    const taken = row ? readLink(row.value) : null;
    if (taken && key(taken) !== key(target)) throw new Error("Slug is already in use");
    return slug;
  }
  draft(target: ArtifactTarget): LinkUpdate {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from pending_links where target = ?", key(target)).toArray()[0];
    return row ? JSON.parse(row.value) : {};
  }
  /** Keep desired URL metadata with invalid drafts without exposing a route. */
  stage(target: ArtifactTarget, generation: number, settings: LinkUpdate): boolean {
    if (this.ownership.isTrashed(target) || this.generation(target) !== generation) return false;
    const previous = this.draft(target);
    const pending = { ...previous,
      ...(settings.slug === undefined ? {} : { slug: validateSlug(settings.slug) }),
      ...(settings.access === undefined ? {} : { access: settings.access }),
    };
    if (pending.access !== undefined && pending.access !== "private" && pending.access !== "public") throw new Error("Invalid access");
    this.ctx.storage.sql.exec("insert into pending_links values (?, ?) on conflict(target) do update set value = excluded.value", key(target), JSON.stringify(pending));
    return true;
  }
  private generation(target: ArtifactTarget): number {
    return this.ctx.storage.sql.exec<{ generation: number }>("select generation from generations where target = ?", key(target)).toArray()[0]?.generation ?? 0;
  }
  /** Issue before saving/compiling. A later edit supersedes every older activation. */
  begin(target: ArtifactTarget): number {
    if (this.ownership.isTrashed(target)) throw new Error("Item is in Trash");
    return this.beginGeneration(target);
  }
  private beginGeneration(target: ArtifactTarget): number {
    const generation = this.generation(target) + 1;
    this.ctx.storage.sql.exec("insert into generations values (?, ?) on conflict(target) do update set generation = excluded.generation", key(target), generation);
    return generation;
  }
  /** Swap executable revision, URL and access in one storage transaction. */
  commit(target: ArtifactTarget, generation: number, update: LinkUpdate): ArtifactLink | null {
    return this.ctx.storage.transactionSync(() => this.commitInTransaction(target, generation, update));
  }
  private commitInTransaction(target: ArtifactTarget, generation: number, update: LinkUpdate): ArtifactLink | null {
    if (this.ownership.isTrashed(target) || this.generation(target) !== generation) return null;
    const previous = this.find(target);
    update = { ...this.draft(target), ...update };
    const slug = this.check(target, update.slug ?? previous?.slug ?? target.name);
    const access = update.access ?? previous?.access ?? "private";
    if (access !== "private" && access !== "public") throw new Error("Invalid access");
    const link: ArtifactLink = { ...previous, ...target, ...update, slug, access, generation };
    this.ctx.storage.sql.exec("delete from links where target = ?", key(target));
    this.ctx.storage.sql.exec("insert into links values (?, ?, ?)", slug, key(target), JSON.stringify(link));
    this.ctx.storage.sql.exec("delete from pending_links where target = ?", key(target));
    return link;
  }
  set(input: ArtifactTarget & { slug: string; access?: "private" | "public" }): ArtifactLink {
    return this.ctx.storage.transactionSync(() => {
      if (this.ownership.isTrashed(input)) throw new Error("Item is in Trash");
      this.check(input, input.slug);
      // Explicit metadata actions replace draft intent, including pending public
      // access, so a subsequent source fix cannot undo a revocation.
      this.ctx.storage.sql.exec("delete from pending_links where target = ?", key(input));
      return this.commitInTransaction(input, this.begin(input), input)!;
    });
  }
  activate(target: ArtifactTarget, generation: number, version_id: string): boolean {
    if (!this.find(target)) return false;
    return this.commit(target, generation, { version_id }) !== null;
  }
}
