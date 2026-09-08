import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ArtifactLibrary } from "./library";
import type { ScriptLibrary } from "./scripts";
import type { ArtifactTarget } from "./links";

export type OwnershipEnvironment = { LIBRARIES: DurableObjectNamespace<ArtifactLibrary>; SCRIPTS: DurableObjectNamespace<ScriptLibrary> };
export type LibrarySelection = { libraryKey: string; workspace: string; kind: "artifact" | "script"; name?: string; version_id?: string };
export type CatalogRow = {
  workspace: string; name: string; id?: string; version_id?: string; created_at?: string;
  artifact_id?: string; source_path?: string; path?: string; source_hash?: string; updated_at?: string;
  runtime?: string; reason?: string; restored_from?: string | null; revision?: number; serve_count?: number;
  active_hash?: string | null; kind?: "script";
};

type OwnershipRow = { physical: string; owner: string; workspace: string; kind: string; name: string };
const physicalKey = (target: ArtifactTarget) => JSON.stringify([target.libraryKey, target.workspace, target.kind, target.name]);
const fromKey = (value: string): ArtifactTarget => {
  const [libraryKey, workspace, kind, name] = JSON.parse(value);
  return { libraryKey, workspace, kind, name };
};
export function ownershipName(kind: "artifact" | "script", value: unknown): string {
  if (typeof value !== "string") throw new Error("name is required");
  const name = value.trim().replace(kind === "artifact" ? /\.artifact\.tsx$/ : /\.script\.ts$/, "");
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || new TextEncoder().encode(name + (kind === "artifact" ? ".artifact.tsx" : "")).byteLength > 255) throw new Error("invalid name");
  return name;
}

// Match SQLite's default UTF-8 binary ordering when merging paginated sources.
function compareText(a: string, b: string): number {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

/** Logical ownership changes; physical storage identities never move. */
export class LibraryOwnership {
  private admission: Promise<void> = Promise.resolve();
  constructor(private readonly sql: SqlStorage, private readonly env: OwnershipEnvironment) {
    sql.exec(`create table if not exists library_ownership (
      physical text primary key, owner text not null, workspace text not null, kind text not null, name text not null,
      unique(owner,workspace,kind,name)
    )`);
  }

  // Only admission and destination reservation are serialized. Source compilation,
  // HTTP handlers and file transfers run outside this queue. A request admitted
  // before a move may finish; every later admission sees the committed owner.
  // Rejection always releases the queue, and no caller-provided token can reuse an
  // old admission. No pending operation or lock is persisted across DO restarts.
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  owner(target: ArtifactTarget): string {
    return this.sql.exec<{ owner: string }>("select owner from library_ownership where physical=?", physicalKey(target)).toArray()[0]?.owner ?? target.libraryKey;
  }

  private mapped(selection: LibrarySelection & { name: string }): ArtifactTarget | null {
    const row = this.sql.exec<OwnershipRow>("select * from library_ownership where owner=? and workspace=? and kind=? and name=?", selection.libraryKey, selection.workspace, selection.kind, selection.name).toArray()[0];
    if (row) return fromKey(row.physical);
    const physical = { libraryKey: selection.libraryKey, workspace: selection.workspace, kind: selection.kind, name: selection.name };
    return this.owner(physical) === selection.libraryKey ? physical : null;
  }

  private register(target: ArtifactTarget, owner: string) {
    this.sql.exec("insert into library_ownership(physical,owner,workspace,kind,name) values(?,?,?,?,?) on conflict(physical) do update set owner=excluded.owner", physicalKey(target), owner, target.workspace, target.kind, target.name);
  }

  private sources(libraryKey: string, kind: "artifact" | "script", workspace?: string): string[] {
    const rows = this.sql.exec<OwnershipRow>("select * from library_ownership where owner=? and kind=? and (? is null or workspace=?)", libraryKey, kind, workspace ?? null, workspace ?? null).toArray();
    return [...new Set([libraryKey, ...rows.map(row => fromKey(row.physical).libraryKey)])];
  }

  private async exists(target: ArtifactTarget): Promise<boolean> {
    const library = target.kind === "artifact" ? this.env.LIBRARIES.getByName(target.libraryKey) : this.env.SCRIPTS.getByName(target.libraryKey);
    try { await library.readRange({ workspace: target.workspace, name: target.name }); return true; }
    catch (error) { if (!(error instanceof Error) || !error.message.includes("not found")) throw error; }
    return (await library.history({ workspace: target.workspace, name: target.name, limit: 1 })).length !== 0;
  }

  private async resolve(selection: LibrarySelection): Promise<ArtifactTarget> {
    if (selection.kind !== "artifact" && selection.kind !== "script") throw new Error("kind must be artifact or script");
    const name = selection.name === undefined ? undefined : ownershipName(selection.kind, selection.name);
    if (selection.version_id) {
      for (const libraryKey of this.sources(selection.libraryKey, selection.kind, selection.workspace)) {
        const library = selection.kind === "artifact" ? this.env.LIBRARIES.getByName(libraryKey) : this.env.SCRIPTS.getByName(libraryKey);
        let version;
        try { version = await library.version({ workspace: selection.workspace, id: selection.version_id }); }
        catch (error) { if (!(error instanceof Error) || !error.message.includes("not found")) throw error; continue; }
        const target = { libraryKey, workspace: selection.workspace, kind: selection.kind, name: version.name };
        if (this.owner(target) !== selection.libraryKey) continue;
        if (name !== undefined && name !== target.name) throw new Error("Version does not belong to this item");
        return target;
      }
      throw new Error("version not found in this library");
    }
    if (name === undefined) throw new Error("name or version_id is required");
    const target = this.mapped({ ...selection, name });
    if (!target) throw new Error("item not found in this library");
    return target;
  }

  admit(selection: LibrarySelection, create = false): Promise<ArtifactTarget> {
    return this.serialized(async () => {
      if (!create) return this.resolve(selection);
      const name = ownershipName(selection.kind, selection.name);
      const target = this.mapped({ ...selection, name }) ?? {
        // A vacated physical name still owns its old history and databases. A new
        // item with that logical name gets fresh storage instead of overwriting it.
        libraryKey: `item:${crypto.randomUUID()}`, workspace: selection.workspace, kind: selection.kind, name,
      };
      this.register(target, selection.libraryKey);
      return target;
    });
  }

  admitRemix(selection: LibrarySelection, newName: string): Promise<ArtifactTarget> {
    return this.serialized(async () => {
      const source = await this.resolve(selection);
      const name = ownershipName(selection.kind, newName);
      const logical = this.mapped({ ...selection, name });
      const target = { ...source, name };
      // Provenance references live in the source library. Keep the existing remix
      // transaction there, reserving its new logical identity before execution.
      if ((logical && await this.exists(logical)) || await this.exists(target) || this.owner(target) !== source.libraryKey && this.owner(target) !== selection.libraryKey) throw new Error("Destination name is already in use; choose a new name");
      const claimed = this.sql.exec<OwnershipRow>("select * from library_ownership where owner=? and workspace=? and kind=? and name=?", selection.libraryKey, selection.workspace, selection.kind, name).toArray()[0];
      if (claimed && claimed.physical !== physicalKey(target)) throw new Error("Destination name is already in use; choose a new name");
      this.register(target, selection.libraryKey);
      return source;
    });
  }

  move(selection: LibrarySelection & { name: string }, destination: string) {
    return this.serialized(async () => {
      const source = await this.resolve(selection);
      if (!await this.exists(source)) throw new Error("item not found in this library");
      if (destination === selection.libraryKey) throw new Error("Item is already in this library");
      const target = { ...selection, libraryKey: destination, name: source.name };
      const claimed = this.sql.exec<OwnershipRow>("select * from library_ownership where owner=? and workspace=? and kind=? and name=?", destination, source.workspace, source.kind, source.name).toArray()[0];
      const existing = this.mapped(target);
      if (claimed || existing && await this.exists(existing)) throw new Error("Destination name is already in use; choose a new name");
      // One SQLite statement is the ownership linearization point. Neither URL
      // metadata nor any source, revision, runtime database or schedule is copied.
      this.register(source, destination);
      return { workspace: source.workspace, name: source.name, kind: source.kind };
    });
  }

  catalog(input: { libraryKey: string; kind: "artifact" | "script"; workspace?: string; name?: string; method: "listDrafts" | "history"; offset?: number; limit?: number }): Promise<CatalogRow[]> {
    return this.serialized(async () => {
      const offset = input.offset ?? 0, limit = input.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid pagination");
      const name = input.name === undefined ? undefined : ownershipName(input.kind, input.name);
      const result: CatalogRow[] = [];
      for (const libraryKey of this.sources(input.libraryKey, input.kind, input.workspace)) {
        const library = input.kind === "artifact" ? this.env.LIBRARIES.getByName(libraryKey) : this.env.SCRIPTS.getByName(libraryKey);
        let accepted = 0;
        for (let page = 0; accepted < offset + limit; page += 100) {
          const rows = await library[input.method]({ workspace: input.workspace, ...(input.method === "history" ? { name } : {}), offset: page, limit: 100 }) as CatalogRow[];
          for (const row of rows) {
            const rowName = input.method === "listDrafts" && input.kind === "artifact" ? row.id! : row.name;
            if (name !== undefined && rowName !== name) continue;
            if (this.owner({ libraryKey, workspace: row.workspace, name: rowName, kind: input.kind }) !== input.libraryKey) continue;
            result.push(row as CatalogRow); accepted++;
          }
          if (rows.length < 100) break;
        }
      }
      result.sort(input.method === "history" && input.kind === "script"
        ? (a, b) => compareText(b.created_at ?? "", a.created_at ?? "")
        : (a, b) => compareText(a.workspace, b.workspace)
          || compareText(input.method === "listDrafts" && input.kind === "artifact" ? a.id! : a.name,
            input.method === "listDrafts" && input.kind === "artifact" ? b.id! : b.name)
          || (input.method === "history" ? b.revision! - a.revision! : 0));
      return result.slice(offset, offset + limit);
    });
  }
}
