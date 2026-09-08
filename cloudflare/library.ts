import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { ProjectStorage } from "./project-storage";
import { emptyProject, normalizeProject, type ArtifactProject } from "./project";
import type { HistoryEntry, ServeEvent, Version } from "../src/historyTypes";

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;
const CANVAS_SUFFIX = ".canvas.tsx";
const encoder = new TextEncoder();

export type CanvasEdit = { old_text: string; new_text: string };

type DraftRow = {
  workspace: string; name: string; source: string; server_source: string | null; source_hash: string;
  project: string; state: string; created_at: string; updated_at: string;
};
type DraftListRow = Pick<DraftRow, "workspace" | "name" | "source_hash" | "updated_at">;
type StoredVersion = Version & { server_source: string | null; compiled_id: string | null; project: ArtifactProject };
export type CompiledCanvas = { id: string; runtime: string; client_js: string; server_js: string | null };
type CompiledRow = { id: string; runtime: string; source_hash: string; server_hash: string | null; project_hash: string };
type VersionRow = Omit<StoredVersion, "project"> & { project: string };
function projectFile(project: ArtifactProject, file: string): string {
  if (!Object.hasOwn(project.files, file)) throw new Error("project file not found");
  return project.files[file]!;
}

function projectHash(project?: ArtifactProject): string { return sha256(JSON.stringify(normalizeProject(project))); }

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
function serverSourcePath(workspace: string, name: string): string { return `${workspace}/${name}.canvas.server.ts`; }
function rows<Row extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<Row>): Row[] { return cursor.toArray(); }
function first<Row extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<Row>): Row | null { return rows(cursor)[0] ?? null; }
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class CanvasLibrary extends DurableObject<unknown> {
  private readonly state: DurableObjectState;
  private readonly sql: SqlStorage;
  private readonly projectStorage: ProjectStorage;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.state = state;
    this.sql = state.storage.sql;
    this.projectStorage = new ProjectStorage(this.sql);
    state.storage.transactionSync(() => {
      this.sql.exec("pragma foreign_keys = on");
      this.sql.exec(`create table if not exists drafts (
        workspace text not null, name text not null, source text not null, server_source text, source_hash text not null,
        state text not null default '{}', created_at text not null, updated_at text not null,
        primary key (workspace, name)
      )`);
      this.sql.exec(`create table if not exists artifacts (
        id text primary key, workspace text not null, name text not null,
        source_path text not null, created_at text not null, unique(workspace, name)
      )`);
      this.sql.exec(`create table if not exists versions (
        id text primary key, artifact_id text not null references artifacts(id), revision integer not null,
        source text not null, server_source text, source_hash text not null, runtime text not null, created_at text not null,
        reason text not null, restored_from text references versions(id), unique(artifact_id, revision)
      )`);
      this.sql.exec(`create table if not exists serve_events (
        id text primary key, version_id text not null references versions(id), served_at text not null,
        pane_id text, session_id text, mode text not null, initial_state text not null, runtime text not null
      )`);
      if (!rows(this.sql.exec<{ name: string }>("pragma table_info(drafts)")).some(column => column.name === "server_source")) {
        this.sql.exec("alter table drafts add column server_source text");
      }
      if (!rows(this.sql.exec<{ name: string }>("pragma table_info(versions)")).some(column => column.name === "server_source")) {
        this.sql.exec("alter table versions add column server_source text");
      }
      if (!rows(this.sql.exec<{ name: string }>("pragma table_info(versions)")).some(column => column.name === "compiled_id")) {
        this.sql.exec("alter table versions add column compiled_id text");
      }
      this.sql.exec(`create table if not exists compiled_canvases (
        workspace text not null, name text not null, id text not null, runtime text not null,
        source_hash text not null, server_hash text, primary key(workspace,name,id)
      )`);
      if (!rows(this.sql.exec<{ name: string }>("pragma table_info(compiled_canvases)")).some(column => column.name === "project_hash")) {
        this.sql.exec(`alter table compiled_canvases add column project_hash text not null default '${projectHash()}'`);
      }
      this.sql.exec(`create table if not exists compiled_canvas_chunks (
        workspace text not null, name text not null, compiled_id text not null,
        part text not null, ordinal integer not null, code text not null,
        primary key(workspace,name,compiled_id,part,ordinal),
        foreign key(workspace,name,compiled_id) references compiled_canvases(workspace,name,id)
      )`);
      this.sql.exec("create table if not exists remix_origins (workspace text not null, name text not null, source_name text not null, source_version_id text not null references versions(id), primary key(workspace,name))");
      for (const table of ["drafts", "versions"]) {
        if (!rows(this.sql.exec<{ name: string }>(`pragma table_info(${table})`)).some(column => column.name === "project")) {
          this.sql.exec(`alter table ${table} add column project text not null default '{"files":{},"dependencies":{},"lock":{}}'`);
        }
      }
      this.sql.exec("create index if not exists serve_events_version on serve_events(version_id, served_at)");
    });
  }

  saveCompiled(input: { workspace: string; name: string; source: string; server_source: string | null; runtime: string; client_js: string; server_js: string | null; project?: ArtifactProject }): CompiledCanvas {
    const workspace = workspaceName(input.workspace), name = canvasName(input.name);
    const source = sourceText(input.source), server = input.server_source === null ? null : sourceText(input.server_source);
    const runtime = runtimeName(input.runtime);
    if (typeof input.client_js !== "string" || !input.client_js ||
      (server === null ? input.server_js !== null : typeof input.server_js !== "string" || !input.server_js)) throw new Error("invalid compiled canvas output");
    const project = normalizeProject(input.project);
    const project_hash = projectHash(project);
    // Preserve IDs of bundles written before projects were supported.
    const id = sha256(JSON.stringify(project_hash === projectHash() ? [source, server, runtime] : [source, server, runtime, project]));
    return this.state.storage.transactionSync(() => {
      const existing = this.compiled({ workspace, name, id });
      if (existing) {
        if (existing.client_js !== input.client_js || existing.server_js !== input.server_js) throw new Error("compiled canvas output is immutable");
        return existing;
      }
      this.sql.exec("insert into compiled_canvases(workspace,name,id,runtime,source_hash,server_hash,project_hash) values(?,?,?,?,?,?,?)",
        workspace, name, id, runtime, sha256(source), server === null ? null : sha256(server), project_hash);
      // Keep every SQLite row small, without splitting a Unicode surrogate pair.
      for (const [part, code] of [["client", input.client_js], ["server", input.server_js]] as const) {
        if (code === null) continue;
        let ordinal = 0;
        for (let start = 0; start < code.length;) {
          let end = Math.min(start + 16 * 1024, code.length);
          if (end < code.length && /[\uD800-\uDBFF]/.test(code[end - 1]!)) end--;
          this.sql.exec("insert into compiled_canvas_chunks(workspace,name,compiled_id,part,ordinal,code) values(?,?,?,?,?,?)",
            workspace, name, id, part, ordinal++, code.slice(start, end));
          start = end;
        }
      }
      return { id, runtime, client_js: input.client_js, server_js: input.server_js };
    });
  }

  compiled(input: { workspace: string; name: string; id?: string; source?: string; server_source?: string | null; runtime?: string; project?: ArtifactProject }): CompiledCanvas | null {
    const workspace = workspaceName(input.workspace), name = canvasName(input.name);
    let metadata: CompiledRow | null;
    if (input.id !== undefined) {
      metadata = first(this.sql.exec<CompiledRow>("select * from compiled_canvases where workspace=? and name=? and id=?", workspace, name, input.id));
    } else {
      const source = sourceText(input.source!);
      const server = input.server_source == null ? null : sourceText(input.server_source);
      metadata = first(this.sql.exec<CompiledRow>(`select * from compiled_canvases where workspace=? and name=? and source_hash=? and server_hash is ?
        and project_hash=? and (? is null or runtime=?) order by rowid desc limit 1`, workspace, name, sha256(source), server === null ? null : sha256(server), projectHash(input.project),
        input.runtime === undefined ? null : runtimeName(input.runtime), input.runtime ?? null));
    }
    if (!metadata || (input.project !== undefined && metadata.project_hash !== projectHash(input.project))) return null;
    const chunks = rows(this.sql.exec<{ part: string; code: string }>("select part,code from compiled_canvas_chunks where workspace=? and name=? and compiled_id=? order by part,ordinal", workspace, name, metadata.id));
    return { id: metadata.id, runtime: metadata.runtime,
      client_js: chunks.filter(chunk => chunk.part === "client").map(chunk => chunk.code).join(""),
      server_js: metadata.server_hash === null ? null : chunks.filter(chunk => chunk.part === "server").map(chunk => chunk.code).join("") };
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

  writeDraft(input: { workspace: string; name: string; source: string; server_source?: string | null; project?: ArtifactProject }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const source = sourceText(input.source, true); const source_hash = sha256(source); const timestamp = now();
    const requestedServer = input.server_source === undefined ? undefined
      : input.server_source === null ? null : sourceText(input.server_source);
    return this.state.storage.transactionSync(() => {
      const current = first(this.sql.exec<DraftRow>("select * from drafts where workspace = ? and name = ?", workspace, name));
      const server_source = requestedServer === undefined ? current?.server_source ?? null : requestedServer;
      const project = input.project === undefined ? current?.project ?? this.projectStorage.encode(emptyProject()) : this.projectStorage.encode(input.project);
      this.sql.exec(`insert into drafts (workspace,name,source,server_source,source_hash,project,state,created_at,updated_at)
        values (?, ?, ?, ?, ?, ?, '{}', ?, ?)
        on conflict(workspace,name) do update set source=excluded.source, server_source=excluded.server_source,
          source_hash=excluded.source_hash, project=excluded.project, updated_at=excluded.updated_at`,
      workspace, name, source, server_source, source_hash, project, timestamp, timestamp);
      const saved = this.draft(workspace, name);
      return { ok: true, path: sourcePath(workspace, name), workspace, name, source, server_source: saved.server_source,
        source_hash, project: this.projectStorage.read(saved.project), state: JSON.parse(saved.state) as Record<string, unknown> };
    });
  }

  remix(input: { workspace: string; name?: string; version_id?: string; new_name: string; runtime: string }) {
    const workspace = workspaceName(input.workspace), name = canvasName(input.new_name), runtime = runtimeName(input.runtime);
    if (Boolean(input.name) === Boolean(input.version_id)) throw new Error("provide name or version_id, but not both");
    return this.state.storage.transactionSync(() => {
      if (first(this.sql.exec("select name from drafts where workspace=? and name=? union all select name from artifacts where workspace=? and name=?", workspace, name, workspace, name))) throw new Error("Destination canvas already exists; choose a new name");
      let origin: StoredVersion;
      if (input.version_id) {
        const version = this.findVersion(workspace, input.version_id);
        if (!version) throw new Error("version not found in this workspace");
        origin = version;
      } else {
        const draft = this.draft(workspace, canvasName(input.name));
        origin = this.capture(workspace, draft.name, draft.source, draft.server_source, this.projectStorage.read(draft.project), runtime, "remix-source", null, false);
      }
      const timestamp = now();
      // Copy the immutable source pair only. State and backend identity start fresh.
      this.sql.exec("insert into drafts(workspace,name,source,server_source,source_hash,project,state,created_at,updated_at) values(?,?,?,?,?,?,'{}',?,?)", workspace, name, origin.source, origin.server_source, sha256(origin.source), this.projectStorage.encode(origin.project), timestamp, timestamp);
      this.sql.exec("insert into remix_origins values(?,?,?,?)", workspace, name, origin.name, origin.id);
      const version = this.capture(workspace, name, origin.source, origin.server_source, origin.project, runtime, "remix", null, true);
      return { ok: true, remixed: true, workspace, name, path: sourcePath(workspace,name), source: origin.source, server_source: origin.server_source, project: origin.project, source_hash: sha256(origin.source), state: {}, versionId: version.id, revision: version.revision, origin: { source_name: origin.name, source_version_id: origin.id } };
    });
  }

  readRange(input: { workspace: string; name: string; part?: "client" | "server"; file?: string; start_line?: number; end_line?: number }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const row = this.draft(workspace, name);
    const part = input.part ?? "client";
    if (part !== "client" && part !== "server") throw new Error("part must be client or server");
    if (input.file === undefined && part === "server" && row.server_source === null) throw new Error("canvas has no server source");
    const project = this.projectStorage.read(row.project);
    const selected = input.file === undefined ? (part === "client" ? row.source : row.server_source!) : projectFile(project, input.file);
    const lines = selected === "" ? [""] : selected.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const start = input.start_line === undefined ? 1 : input.start_line;
    const end = input.end_line === undefined ? start + 199 : input.end_line;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) {
      throw new Error("line range must contain positive integers with end_line >= start_line");
    }
    if (start > Math.max(1, lines.length)) throw new Error("start_line is past the end of the canvas");
    const actualEnd = Math.min(end, lines.length);
    return {
      path: input.file ?? (part === "client" ? sourcePath(workspace, name) : serverSourcePath(workspace, name)),
      part, file: input.file, project, source_hash: input.file === undefined && part === "client" ? row.source_hash : sha256(selected),
      total_lines: lines.length,
      start_line: start, end_line: actualEnd, source: lines.slice(start - 1, actualEnd).join(""),
      next_line: actualEnd < lines.length ? actualEnd + 1 : null,
    };
  }

  editDraft(input: { workspace: string; name: string; part?: "client" | "server"; file?: string; edits: CanvasEdit[]; expected_hash?: string }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const part = input.part ?? "client";
    if (part !== "client" && part !== "server") throw new Error("part must be client or server");
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edits must be a non-empty array");
    if (input.expected_hash !== undefined && (typeof input.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_hash))) {
      throw new Error("expected_hash must be a SHA-256 hex string");
    }
    return this.state.storage.transactionSync(() => {
      const original = this.draft(workspace, name);
      if (input.file === undefined && part === "server" && original.server_source === null) throw new Error("canvas has no server source");
      let project = this.projectStorage.read(original.project);
      const originalSelected = input.file === undefined ? (part === "client" ? original.source : original.server_source!) : projectFile(project, input.file);
      const originalHash = input.file === undefined && part === "client" ? original.source_hash : sha256(originalSelected);
      if (input.expected_hash !== undefined && originalHash !== input.expected_hash) {
        throw new Error("canvas changed since read; read it again before editing");
      }
      let selected = originalSelected;
      for (const [index, edit] of input.edits.entries()) {
        if (!edit || typeof edit.old_text !== "string" || edit.old_text.length === 0 || typeof edit.new_text !== "string") {
          throw new Error(`edit ${index + 1}: old_text must be non-empty and new_text must be a string`);
        }
        const at = selected.indexOf(edit.old_text);
        if (at === -1) throw new Error(`edit ${index + 1}: old_text not found; no changes written`);
        if (selected.indexOf(edit.old_text, at + 1) !== -1) throw new Error(`edit ${index + 1}: old_text is ambiguous; include more context; no changes written`);
        selected = selected.slice(0, at) + edit.new_text + selected.slice(at + edit.old_text.length);
      }
      sourceText(selected);
      const changed = selected !== originalSelected; const source_hash = sha256(selected);
      if (changed && input.file === undefined && part === "client") this.sql.exec("update drafts set source = ?, source_hash = ?, updated_at = ? where workspace = ? and name = ?", selected, source_hash, now(), workspace, name);
      if (changed && input.file === undefined && part === "server") this.sql.exec("update drafts set server_source = ?, updated_at = ? where workspace = ? and name = ?", selected, now(), workspace, name);
      if (changed && input.file !== undefined) {
        project = normalizeProject({ ...project, files: { ...project.files, [input.file]: selected } });
        this.sql.exec("update drafts set project = ?, updated_at = ? where workspace = ? and name = ?", this.projectStorage.encode(project), now(), workspace, name);
      }
      return { ok: true, applied: true, changed, project, file: input.file, path: input.file ?? (part === "client" ? sourcePath(workspace, name) : serverSourcePath(workspace, name)),
        workspace, name, source: input.file === undefined && part === "client" ? selected : original.source,
        server_source: input.file === undefined && part === "server" ? selected : original.server_source, source_part: part,
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

  attachCompiled(input: { workspace: string; name: string; version_id: string; compiled_id: string }) {
    const workspace = workspaceName(input.workspace), name = canvasName(input.name);
    return this.state.storage.transactionSync(() => {
      const version = this.findVersion(workspace, input.version_id);
      const compiled = first(this.sql.exec<CompiledRow>("select * from compiled_canvases where workspace=? and name=? and id=?", workspace, name, input.compiled_id));
      if (!version || version.name !== name || !compiled || compiled.project_hash !== projectHash(version.project) || compiled.source_hash !== sha256(version.source) || compiled.server_hash !== (version.server_source === null ? null : sha256(version.server_source))) {
        throw new Error("compiled canvas does not match version in this workspace");
      }
      if (version.compiled_id !== null && version.compiled_id !== input.compiled_id) throw new Error("version compiled canvas is immutable");
      if (version.compiled_id === null) this.sql.exec("update versions set compiled_id=? where id=?", input.compiled_id, version.id);
      return { ok: true };
    });
  }

  recordServe(input: {
    workspace: string; name: string; source: string; server_source?: string | null; project?: ArtifactProject; runtime: string;
    initial_state: Record<string, unknown>; mode: "live" | "replay" | "preview";
    pane_id?: string; session_id?: string; version_id?: string; compiled_id?: string;
  }) {
    const workspace = workspaceName(input.workspace); const name = canvasName(input.name);
    const source = sourceText(input.source); const runtime = runtimeName(input.runtime);
    const server_source = input.server_source == null ? null : sourceText(input.server_source);
    const project = input.project === undefined ? emptyProject() : normalizeProject(input.project);
    const initial_state = jsonState(input.initial_state);
    if (!(["live", "replay", "preview"] as const).includes(input.mode)) throw new Error("invalid serve mode");
    for (const [label, value] of [["pane_id", input.pane_id], ["session_id", input.session_id]] as const) {
      if (value !== undefined && (typeof value !== "string" || bytes(value) > 4096)) throw new Error(`${label} must be a string no longer than 4 KiB`);
    }
    return this.state.storage.transactionSync(() => {
      let version: StoredVersion;
      if (input.compiled_id !== undefined) {
        const compiled = first(this.sql.exec<CompiledRow>("select * from compiled_canvases where workspace=? and name=? and id=?", workspace, name, input.compiled_id));
        if (!compiled || compiled.project_hash !== projectHash(project) || compiled.source_hash !== sha256(source) || compiled.server_hash !== (server_source === null ? null : sha256(server_source)) || compiled.runtime !== runtime) {
          throw new Error("compiled canvas does not match serve snapshot");
        }
      }
      if (input.version_id !== undefined) {
        const archived = this.findVersion(workspace, input.version_id);
        if (!archived || archived.name !== name || archived.source !== source || archived.server_source !== server_source || JSON.stringify(archived.project) !== JSON.stringify(project)) {
          throw new Error("archived serve snapshot does not match version in this workspace");
        }
        if (input.compiled_id !== undefined) {
          if (archived.compiled_id !== null && archived.compiled_id !== input.compiled_id) throw new Error("version compiled canvas is immutable");
          if (archived.compiled_id === null) this.sql.exec("update versions set compiled_id=? where id=?", input.compiled_id, archived.id);
          archived.compiled_id = input.compiled_id;
        }
        version = archived;
      } else {
        version = this.capture(workspace, name, source, server_source, project, runtime, "served", null, false, input.compiled_id);
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
    return { ...version, origin: first(this.sql.exec<{ source_name: string; source_version_id: string }>("select source_name,source_version_id from remix_origins where workspace=? and name=?", workspace, version.name)), events, events_offset, next_events_offset: events.length === 20 ? events_offset + 20 : null };
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
      if (current) this.capture(workspace, target.name, current.source, current.server_source, this.projectStorage.read(current.project), runtime, "before-restore", null, false);
      const timestamp = now();
      this.sql.exec(`insert into drafts (workspace,name,source,server_source,source_hash,project,state,created_at,updated_at)
        values (?, ?, ?, ?, ?, ?, '{}', ?, ?)
        on conflict(workspace,name) do update set source=excluded.source, server_source=excluded.server_source,
          source_hash=excluded.source_hash, project=excluded.project, updated_at=excluded.updated_at`,
      workspace, target.name, target.source, target.server_source, target.source_hash, this.projectStorage.encode(target.project), timestamp, timestamp);
      const revision = this.capture(workspace, target.name, target.source, target.server_source, target.project, runtime, "restore", target.id, true);
      const restored = this.draft(workspace, target.name);
      return { ok: true, restored: true, path: sourcePath(workspace, target.name), workspace, name: target.name,
        source: target.source, server_source: target.server_source, project: target.project, source_hash: target.source_hash,
        state: JSON.parse(restored.state) as Record<string, unknown>, versionId: revision.id, revision: revision.revision };
    });
  }

  preview(input: { workspace: string; name?: string; version_id?: string; event_id?: string }) {
    const workspace = workspaceName(input.workspace);
    if (Boolean(input.name) === Boolean(input.version_id)) throw new Error("provide name or version_id, but not both");
    if (input.name) {
      if (input.event_id !== undefined) throw new Error("event_id requires version_id");
      const name = canvasName(input.name); const draft = this.draft(workspace, name);
      return { workspace, name, path: sourcePath(workspace, name), source: draft.source, server_source: draft.server_source, project: this.projectStorage.read(draft.project),
        state: JSON.parse(draft.state) as Record<string, unknown>, version_id: null, event_id: null, compiled_id: null };
    }
    const version = this.findVersion(workspace, input.version_id!);
    if (!version) throw new Error("version not found in this workspace");
    const event = input.event_id
      ? first(this.sql.exec<ServeEvent>("select * from serve_events where id = ? and version_id = ?", input.event_id, version.id))
      : first(this.sql.exec<ServeEvent>("select * from serve_events where version_id = ? order by (mode = 'live') desc, rowid desc limit 1", version.id));
    if (input.event_id && !event) throw new Error("serve event not found for version");
    return { workspace, name: version.name, path: version.source_path, source: version.source, server_source: version.server_source, project: version.project,
      state: event ? JSON.parse(event.initial_state) as Record<string, unknown> : {}, version_id: version.id, event_id: event?.id ?? null, compiled_id: version.compiled_id };
  }

  private draft(workspace: string, name: string): DraftRow {
    const result = first(this.sql.exec<DraftRow>("select * from drafts where workspace = ? and name = ?", workspace, name));
    if (!result) throw new Error("canvas not found");
    return result;
  }

  private findVersion(workspace: string, id: unknown): StoredVersion | null {
    if (typeof id !== "string" || !id) return null;
    const row = first(this.sql.exec<VersionRow>(`select v.*, a.workspace, a.name, a.source_path from versions v
      join artifacts a on a.id = v.artifact_id where v.id = ? and a.workspace = ?`, id, workspace));
    return row ? { ...row, project: this.projectStorage.read(row.project) } : null;
  }

  private capture(workspace: string, name: string, source: string, server_source: string | null, project: ArtifactProject, runtime: string, reason: string, restoredFrom: string | null, force: boolean, compiledId?: string): StoredVersion {
    let artifact = first(this.sql.exec<{ id: string }>("select id from artifacts where workspace = ? and name = ?", workspace, name));
    if (!artifact) {
      artifact = { id: uuid() };
      this.sql.exec("insert into artifacts values (?, ?, ?, ?, ?)", artifact.id, workspace, name, sourcePath(workspace, name), now());
    }
    const source_hash = sha256(source);
    const latest = first(this.sql.exec<{ id: string; revision: number; source: string; server_source: string | null; source_hash: string; project: string; compiled_id: string | null }>("select id,revision,source,server_source,source_hash,project,compiled_id from versions where artifact_id = ? order by revision desc limit 1", artifact.id));
    if (!force && latest && latest.source_hash === source_hash && latest.source === source && latest.server_source === server_source && JSON.stringify(this.projectStorage.read(latest.project)) === JSON.stringify(project) && (compiledId === undefined || latest.compiled_id === compiledId)) return this.findVersion(workspace, latest.id)!;
    const id = uuid(); const created_at = now(); const revision = (latest?.revision ?? 0) + 1;
    this.sql.exec(`insert into versions (id,artifact_id,revision,source,server_source,source_hash,runtime,created_at,reason,restored_from,project,compiled_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, artifact.id, revision, source, server_source, source_hash, runtime, created_at, reason, restoredFrom, this.projectStorage.encode(project), compiledId ?? null);
    return this.findVersion(workspace, id)!;
  }
}
