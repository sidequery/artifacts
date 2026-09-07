import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type { HistoryEntry, ServeEvent, Version } from "../src/historyTypes";

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
const CANVAS_SUFFIX = ".canvas.tsx";
const encoder = new TextEncoder();

export type CanvasEdit = { old_text: string; new_text: string };

type DraftRow = {
  workspace: string; name: string; source: string; source_hash: string;
  state: string; created_at: string; updated_at: string;
};
type DraftListRow = Pick<DraftRow, "workspace" | "name" | "source_hash" | "updated_at">;

function bytes(value: string): number { return encoder.encode(value).byteLength; }

function workspaceName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error("workspace is required");
  const workspace = value.trim();
  if (bytes(workspace) > 4096) throw new Error("workspace exceeds 4 KiB");
  return workspace;
}

function optionalWorkspace(value: unknown): string | undefined {
  return value === undefined ? undefined : workspaceName(value);
}

function pagination(input: { offset?: number; limit?: number }, defaultLimit: number, maxLimit: number) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? defaultLimit;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new Error(`limit must be a safe integer from 1 to ${maxLimit}`);
  return { offset, limit };
}

function canvasName(value: unknown): string {
  if (typeof value !== "string") throw new Error("canvas name is required");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("canvas name must be a file name without paths");
  }
  const name = trimmed.endsWith(CANVAS_SUFFIX) ? trimmed.slice(0, -CANVAS_SUFFIX.length) : trimmed;
  if (!name || name === "." || name === "..") throw new Error("canvas name is required");
  if (bytes(`${name}${CANVAS_SUFFIX}`) > 255) throw new Error("canvas name exceeds 255 bytes including suffix");
  return name;
}

function sourceText(value: unknown, appendNewline = false): string {
  if (typeof value !== "string") throw new Error("source must be a string");
  const source = appendNewline && !value.endsWith("\n") ? `${value}\n` : value;
  if (bytes(source) > MAX_SOURCE_BYTES) throw new Error("Canvas source exceeds 256 KiB");
  return source;
}

function runtimeName(value: unknown): string {
  if (typeof value !== "string" || !value || bytes(value) > 4096) throw new Error("runtime is required and must not exceed 4 KiB");
  return value;
}

function jsonState(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be an object");
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("state must be JSON serializable"); }
  if (encoded === undefined) throw new Error("state must be JSON serializable");
  if (bytes(encoded) > MAX_STATE_BYTES) throw new Error("Canvas state exceeds 64 KiB");
  return encoded;
}

function now(): string { return new Date().toISOString(); }
function uuid(): string { return crypto.randomUUID(); }
function sourcePath(workspace: string, name: string): string { return `${workspace}/${name}${CANVAS_SUFFIX}`; }
function rows<Row extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<Row>): Row[] { return cursor.toArray(); }
function first<Row extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<Row>): Row | null { return rows(cursor)[0] ?? null; }
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class CanvasLibrary extends DurableObject<unknown> {
  private readonly state: DurableObjectState;
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.state = state;
    this.sql = state.storage.sql;
    state.storage.transactionSync(() => {
      this.sql.exec("pragma foreign_keys = on");
      this.sql.exec(`create table if not exists drafts (
        workspace text not null, name text not null, source text not null, source_hash text not null,
        state text not null default '{}', created_at text not null, updated_at text not null,
        primary key (workspace, name)
      )`);
      this.sql.exec(`create table if not exists artifacts (
        id text primary key, workspace text not null, name text not null,
        source_path text not null, created_at text not null, unique(workspace, name)
      )`);
      this.sql.exec(`create table if not exists versions (
        id text primary key, artifact_id text not null references artifacts(id), revision integer not null,
        source text not null, source_hash text not null, runtime text not null, created_at text not null,
        reason text not null, restored_from text references versions(id), unique(artifact_id, revision)
      )`);
      this.sql.exec(`create table if not exists serve_events (
        id text primary key, version_id text not null references versions(id), served_at text not null,
        pane_id text, session_id text, mode text not null, initial_state text not null, runtime text not null
      )`);
      this.sql.exec("create index if not exists serve_events_version on serve_events(version_id, served_at)");
    });
  }

  listDrafts(input: { workspace?: string; offset?: number; limit?: number } = {}) {
    const workspace = optionalWorkspace(input.workspace);
    const { offset, limit } = pagination(input, 100, 100);
    const result = workspace
      ? rows(this.sql.exec<DraftListRow>("select workspace,name,source_hash,updated_at from drafts where workspace = ? order by workspace,name limit ? offset ?", workspace, limit, offset))
      : rows(this.sql.exec<DraftListRow>("select workspace,name,source_hash,updated_at from drafts order by workspace,name limit ? offset ?", limit, offset));
    return result.map(row => ({
      id: row.name, name: `${row.name}${CANVAS_SUFFIX}`, path: sourcePath(row.workspace, row.name),
      workspace: row.workspace, source_hash: row.source_hash, updated_at: row.updated_at,
    }));
  }

  writeDraft(input: { workspace: string; name: string; source: string }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const source = sourceText(input.source, true); const source_hash = sha256(source); const timestamp = now();
    return this.state.storage.transactionSync(() => {
      this.sql.exec(`insert into drafts (workspace,name,source,source_hash,state,created_at,updated_at)
        values (?, ?, ?, ?, '{}', ?, ?)
        on conflict(workspace,name) do update set source=excluded.source, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
      workspace, name, source, source_hash, timestamp, timestamp);
      const saved = this.draft(workspace, name);
      return { ok: true, path: sourcePath(workspace, name), workspace, name, source, source_hash, state: JSON.parse(saved.state) as Record<string, unknown> };
    });
  }

  readRange(input: { workspace: string; name: string; start_line?: number; end_line?: number }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const row = this.draft(workspace, name);
    const lines = row.source === "" ? [""] : row.source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const start = input.start_line === undefined ? 1 : input.start_line;
    const end = input.end_line === undefined ? start + 199 : input.end_line;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) {
      throw new Error("line range must contain positive integers with end_line >= start_line");
    }
    if (start > Math.max(1, lines.length)) throw new Error("start_line is past the end of the canvas");
    const actualEnd = Math.min(end, lines.length);
    return {
      path: sourcePath(workspace, name), source_hash: row.source_hash, total_lines: lines.length,
      start_line: start, end_line: actualEnd, source: lines.slice(start - 1, actualEnd).join(""),
      next_line: actualEnd < lines.length ? actualEnd + 1 : null,
    };
  }

  editDraft(input: { workspace: string; name: string; edits: CanvasEdit[]; expected_hash?: string }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");
    if (input.expected_hash !== undefined && (typeof input.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_hash))) {
      throw new Error("expected_hash must be a SHA-256 hex string");
    }
    return this.state.storage.transactionSync(() => {
      const original = this.draft(workspace, name);
      if (input.expected_hash !== undefined && original.source_hash !== input.expected_hash) {
        throw new Error("canvas changed since read; read it again before editing");
      }
      let source = original.source;
      for (const [index, edit] of input.edits.entries()) {
        if (!edit || typeof edit.old_text !== "string" || edit.old_text.length === 0 || typeof edit.new_text !== "string") {
          throw new Error(`edit ${index + 1}: old_text must be non-empty and new_text must be a string`);
        }
        const at = source.indexOf(edit.old_text);
        if (at === -1) throw new Error(`edit ${index + 1}: old_text not found; no changes written`);
        if (source.indexOf(edit.old_text, at + 1) !== -1) throw new Error(`edit ${index + 1}: old_text is ambiguous; include more context; no changes written`);
        source = source.slice(0, at) + edit.new_text + source.slice(at + edit.old_text.length);
      }
      sourceText(source);
      const changed = source !== original.source; const source_hash = sha256(source);
      if (changed) this.sql.exec("update drafts set source = ?, source_hash = ?, updated_at = ? where workspace = ? and name = ?", source, source_hash, now(), workspace, name);
      return { ok: true, applied: true, changed, path: sourcePath(workspace, name), workspace, name, source,
        state: JSON.parse(original.state) as Record<string, unknown>, edits_applied: input.edits.length, source_hash };
    });
  }

  getState(input: { workspace: string; name: string }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    return JSON.parse(this.draft(workspace, name).state) as Record<string, unknown>;
  }

  setState(input: { workspace: string; name: string; key: string; value: unknown }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    if (typeof input.key !== "string" || !input.key || ["__proto__", "constructor", "prototype"].includes(input.key)) throw new Error("invalid state key");
    return this.state.storage.transactionSync(() => {
      const row = this.draft(workspace, name);
      const state = { ...(JSON.parse(row.state) as Record<string, unknown>), [input.key]: input.value };
      const encoded = jsonState(state);
      this.sql.exec("update drafts set state = ?, updated_at = ? where workspace = ? and name = ?", encoded, now(), workspace, name);
      return { ok: true, state };
    });
  }

  recordServe(input: {
    workspace: string; name: string; source: string; runtime: string;
    initial_state: Record<string, unknown>; mode: "live" | "replay" | "preview";
    pane_id?: string; session_id?: string; version_id?: string;
  }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const source = sourceText(input.source); const runtime = runtimeName(input.runtime);
    const initial_state = jsonState(input.initial_state);
    if (!(["live", "replay", "preview"] as const).includes(input.mode)) throw new Error("invalid serve mode");
    for (const [label, value] of [["pane_id", input.pane_id], ["session_id", input.session_id]] as const) {
      if (value !== undefined && (typeof value !== "string" || bytes(value) > 4096)) throw new Error(`${label} must be a string no longer than 4 KiB`);
    }
    return this.state.storage.transactionSync(() => {
      let version: Version;
      if (input.version_id !== undefined) {
        const archived = this.findVersion(workspace, input.version_id);
        if (!archived || archived.name !== name || archived.source !== source) {
          throw new Error("archived serve snapshot does not match version in this workspace");
        }
        version = archived;
      } else {
        version = this.capture(workspace, name, source, runtime, "served", null, false);
      }
      const event: ServeEvent = {
        id: uuid(), version_id: version.id, served_at: now(), pane_id: input.pane_id ?? null,
        session_id: input.session_id ?? null, mode: input.mode, initial_state, runtime,
      };
      this.sql.exec("insert into serve_events values (?, ?, ?, ?, ?, ?, ?, ?)", event.id, event.version_id, event.served_at, event.pane_id, event.session_id, event.mode, event.initial_state, event.runtime);
      return { version, event };
    });
  }

  history(input: { workspace?: string; name?: string; offset?: number; limit?: number } = {}): HistoryEntry[] {
    const workspace = optionalWorkspace(input.workspace);
    const name = input.name === undefined ? undefined : canvasName(input.name);
    const { offset, limit } = pagination(input, 100, 100);
    return rows(this.sql.exec<HistoryEntry>(`select a.id as artifact_id, a.name, a.source_path, a.workspace,
      v.id as version_id, v.revision, v.created_at, v.source_hash, v.runtime, v.reason, v.restored_from,
      (select count(*) from serve_events e where e.version_id = v.id) as serve_count
      from artifacts a join versions v on v.artifact_id = a.id
      where (? is null or a.workspace = ?) and (? is null or a.name = ?)
      order by a.workspace, a.name, v.revision desc limit ? offset ?`,
    workspace ?? null, workspace ?? null, name ?? null, name ?? null, limit, offset));
  }

  version(input: { workspace: string; id: string; events_offset?: number }) {
    const workspace = workspaceName(input.workspace); const version = this.findVersion(workspace, input.id);
    if (!version) throw new Error("version not found in this workspace");
    const events_offset = input.events_offset ?? 0;
    const events = this.events({ workspace, version_id: version.id, offset: events_offset, limit: 20 });
    return { ...version, events, events_offset, next_events_offset: events.length === 20 ? events_offset + 20 : null };
  }

  events(input: { workspace: string; version_id: string; offset?: number; limit?: number }): ServeEvent[] {
    const workspace = workspaceName(input.workspace);
    const { offset, limit } = pagination(input, 20, 20);
    if (!this.findVersion(workspace, input.version_id)) throw new Error("version not found in this workspace");
    return rows(this.sql.exec<ServeEvent>("select e.* from serve_events e where e.version_id = ? order by e.rowid desc limit ? offset ?", input.version_id, limit, offset));
  }

  restore(input: { workspace: string; id: string; runtime: string }) {
    const workspace = workspaceName(input.workspace); const runtime = runtimeName(input.runtime);
    return this.state.storage.transactionSync(() => {
      const target = this.findVersion(workspace, input.id);
      if (!target) throw new Error("version not found in this workspace");
      const current = first(this.sql.exec<DraftRow>("select * from drafts where workspace = ? and name = ?", workspace, target.name));
      if (current) this.capture(workspace, target.name, current.source, runtime, "before-restore", null, false);
      const timestamp = now();
      this.sql.exec(`insert into drafts (workspace,name,source,source_hash,state,created_at,updated_at)
        values (?, ?, ?, ?, '{}', ?, ?)
        on conflict(workspace,name) do update set source=excluded.source, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
      workspace, target.name, target.source, target.source_hash, timestamp, timestamp);
      const revision = this.capture(workspace, target.name, target.source, runtime, "restore", target.id, true);
      const restored = this.draft(workspace, target.name);
      return { ok: true, restored: true, path: sourcePath(workspace, target.name), workspace, name: target.name,
        source: target.source, source_hash: target.source_hash, state: JSON.parse(restored.state) as Record<string, unknown>, versionId: revision.id, revision: revision.revision };
    });
  }

  preview(input: { workspace: string; name?: string; version_id?: string; event_id?: string }) {
    const workspace = workspaceName(input.workspace);
    if (Boolean(input.name) === Boolean(input.version_id)) throw new Error("provide name or version_id, but not both");
    if (input.name) {
      if (input.event_id !== undefined) throw new Error("event_id requires version_id");
      const name = canvasName(input.name); const draft = this.draft(workspace, name);
      return { workspace, name, path: sourcePath(workspace, name), source: draft.source, state: JSON.parse(draft.state) as Record<string, unknown>, version_id: null, event_id: null };
    }
    const version = this.findVersion(workspace, input.version_id!);
    if (!version) throw new Error("version not found in this workspace");
    const event = input.event_id
      ? first(this.sql.exec<ServeEvent>("select * from serve_events where id = ? and version_id = ?", input.event_id, version.id))
      : first(this.sql.exec<ServeEvent>("select * from serve_events where version_id = ? order by (mode = 'live') desc, rowid desc limit 1", version.id));
    if (input.event_id && !event) throw new Error("serve event not found for version");
    return { workspace, name: version.name, path: version.source_path, source: version.source, state: event ? JSON.parse(event.initial_state) as Record<string, unknown> : {}, version_id: version.id, event_id: event?.id ?? null };
  }

  private draft(workspace: string, name: string): DraftRow {
    const result = first(this.sql.exec<DraftRow>("select * from drafts where workspace = ? and name = ?", workspace, name));
    if (!result) throw new Error("canvas not found");
    return result;
  }

  private findVersion(workspace: string, id: unknown): Version | null {
    if (typeof id !== "string" || !id) return null;
    return first(this.sql.exec<Version>(`select v.*, a.workspace, a.name, a.source_path from versions v
      join artifacts a on a.id = v.artifact_id where v.id = ? and a.workspace = ?`, id, workspace));
  }

  private capture(workspace: string, name: string, source: string, runtime: string, reason: string, restoredFrom: string | null, force: boolean): Version {
    let artifact = first(this.sql.exec<{ id: string }>("select id from artifacts where workspace = ? and name = ?", workspace, name));
    if (!artifact) {
      artifact = { id: uuid() };
      this.sql.exec("insert into artifacts values (?, ?, ?, ?, ?)", artifact.id, workspace, name, sourcePath(workspace, name), now());
    }
    const source_hash = sha256(source);
    const latest = first(this.sql.exec<{ id: string; revision: number; source: string; source_hash: string }>("select id,revision,source,source_hash from versions where artifact_id = ? order by revision desc limit 1", artifact.id));
    if (!force && latest && latest.source_hash === source_hash && latest.source === source) return this.findVersion(workspace, latest.id)!;
    const id = uuid(); const created_at = now(); const revision = (latest?.revision ?? 0) + 1;
    this.sql.exec("insert into versions values (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, artifact.id, revision, source, source_hash, runtime, created_at, reason, restoredFrom);
    return this.findVersion(workspace, id)!;
  }
}
