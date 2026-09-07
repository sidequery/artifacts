import { DurableObject } from "cloudflare:workers";

export type ArtifactTarget = { libraryKey: string; workspace: string; kind: "canvas" | "script"; name: string };
export type LinkUpdate = { slug?: string; access?: "private" | "public"; version_id?: string; script_hash?: string };
export type ArtifactLink = ArtifactTarget & LinkUpdate & { slug: string; access: "private" | "public"; generation: number };
const reserved = new Set(["api", "mcp", "gallery", "health", "sign-in", "consent"]);
export function validateSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value) || reserved.has(value)) {
    throw new Error("Slug must be 1–80 lowercase letters, numbers or hyphens and must not be a reserved application route");
  }
  return value;
}
function key(target: ArtifactTarget) { return JSON.stringify([target.libraryKey, target.workspace, target.kind, target.name]); }
/** Deployment-wide names; ownership is resolved before accessing any library. */
export class ArtifactLinks extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec("create table if not exists links (slug text primary key, target text not null unique, value text not null)");
    ctx.storage.sql.exec("create table if not exists generations (target text primary key, generation integer not null)");
    ctx.storage.sql.exec("create table if not exists pending_links (target text primary key, value text not null)");
  }
  get(slug: string): ArtifactLink | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from links where slug = ?", slug).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  find(target: ArtifactTarget): ArtifactLink | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from links where target = ?", key(target)).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  check(target: ArtifactTarget, candidate: string): string {
    const slug = validateSlug(candidate);
    const taken = this.get(slug);
    if (taken && key(taken) !== key(target)) throw new Error("Slug is already in use");
    return slug;
  }
  draft(target: ArtifactTarget): LinkUpdate {
    const row = this.ctx.storage.sql.exec<{ value: string }>("select value from pending_links where target = ?", key(target)).toArray()[0];
    return row ? JSON.parse(row.value) : {};
  }
  /** Keep desired URL metadata with invalid drafts without exposing a route. */
  stage(target: ArtifactTarget, generation: number, settings: LinkUpdate): boolean {
    if (this.generation(target) !== generation) return false;
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
    const generation = this.generation(target) + 1;
    this.ctx.storage.sql.exec("insert into generations values (?, ?) on conflict(target) do update set generation = excluded.generation", key(target), generation);
    return generation;
  }
  /** Swap executable revision, URL and access in one storage transaction. */
  commit(target: ArtifactTarget, generation: number, update: LinkUpdate): ArtifactLink | null {
    return this.ctx.storage.transactionSync(() => {
      if (this.generation(target) !== generation) return null;
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
    });
  }
  set(input: ArtifactTarget & { slug: string; access?: "private" | "public" }): ArtifactLink {
    return this.ctx.storage.transactionSync(() => {
      this.check(input, input.slug);
      // Explicit metadata actions replace draft intent, including pending public
      // access, so a subsequent source fix cannot undo a revocation.
      this.ctx.storage.sql.exec("delete from pending_links where target = ?", key(input));
      return this.commit(input, this.begin(input), input)!;
    });
  }
  activate(target: ArtifactTarget, generation: number, version_id: string): boolean {
    if (!this.find(target)) return false;
    return this.commit(target, generation, { version_id }) !== null;
  }
}
