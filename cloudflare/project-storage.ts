import { createHash } from "node:crypto";
import { normalizeProject, type ArtifactProject } from "./project";

// At most 384 KiB of UTF-8 per chunk (three bytes per UTF-16 code unit).
// Leave headroom below the SQLite Durable Object's 2 MiB row/string limit.
const CHUNK_CODE_UNITS = 128 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type ChunkReference = { project_chunks: string[] };

/** Immutable chunks are retained for every historical snapshot. Encode inside the caller's write transaction. */
export class ProjectStorage {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("create table if not exists project_chunks (hash text primary key, chunk text not null)");
  }

  encode(project: ArtifactProject): string {
    const text = JSON.stringify(normalizeProject(project));
    const chunks: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + CHUNK_CODE_UNITS, text.length);
      // Keep surrogate pairs together so the UTF-8 SQL binding preserves exact text.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = text.slice(start, end), id = hash(chunk);
      this.sql.exec("insert into project_chunks (hash,chunk) values (?,?) on conflict(hash) do nothing", id, chunk);
      chunks.push(id); start = end;
    }
    return JSON.stringify({ project_chunks: chunks } satisfies ChunkReference);
  }

  read(encoded: string): ArtifactProject {
    const value: unknown = JSON.parse(encoded);
    // Existing inline snapshots and the column's empty-project default remain readable.
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "project_chunks")) return normalizeProject(value);
    const reference = value as ChunkReference;
    if (Object.keys(reference).length !== 1 || !Array.isArray(reference.project_chunks) || reference.project_chunks.length === 0 || reference.project_chunks.length > 128 || reference.project_chunks.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid project chunk reference");
    const chunks = reference.project_chunks.map(id => {
      const row = this.sql.exec<{chunk: string}>("select chunk from project_chunks where hash = ?", id).toArray()[0];
      if (!row || hash(row.chunk) !== id) throw new Error("Project snapshot chunk is missing or corrupt");
      return row.chunk;
    });
    return normalizeProject(JSON.parse(chunks.join("")));
  }
}
