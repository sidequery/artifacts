import { normalizeProject } from "../cloudflare/project";
import { MAX_PROJECT_ARCHIVE_BYTES, PROJECT_ARCHIVE_FORMAT, type ProjectArchive } from "./project-archive-contract";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
/** Archives contain code, never storage identities, live data, credentials or URL policy. */
export function parseProjectArchive(value: unknown, kind?: ProjectArchive["kind"]): ProjectArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project archive must be an object");
  const archive = value as Record<string, unknown>;
  if (Object.keys(archive).length !== 7 || Object.keys(archive).some(key => !["format", "version", "kind", "name", "source", "server_source", "project"].includes(key))) throw new Error("Unknown or missing project archive fields");
  if (archive.format !== PROJECT_ARCHIVE_FORMAT || archive.version !== 1) throw new Error("Unsupported project archive format or version");
  if (archive.kind !== "artifact" && archive.kind !== "script" || kind && archive.kind !== kind) throw new Error("Project archive kind does not match this import");
  if (typeof archive.name !== "string" || !archive.name.trim() || bytes(archive.name) > 255 || /[/\\\0]/.test(archive.name)) throw new Error("Invalid project archive name");
  if (typeof archive.source !== "string" || bytes(archive.source) > 256 * 1024 || archive.source.includes("\0")) throw new Error("Project entrypoint exceeds 256 KiB or is invalid");
  if (archive.server_source !== null && (typeof archive.server_source !== "string" || bytes(archive.server_source) > 256 * 1024 || archive.server_source.includes("\0"))) throw new Error("Invalid project server source");
  if (archive.kind === "script" && archive.server_source !== null) throw new Error("Script archives cannot contain artifact server source");
  if (!archive.project || typeof archive.project !== "object" || Array.isArray(archive.project) || !["files", "dependencies", "lock"].every(key => Object.hasOwn(archive.project!, key))) throw new Error("Project archive is missing its complete dependency snapshot");
  const project = normalizeProject(archive.project);
  const result = { format: PROJECT_ARCHIVE_FORMAT, version: 1, kind: archive.kind, name: archive.name, source: archive.source, server_source: archive.server_source, project } as ProjectArchive;
  if (bytes(JSON.stringify(result)) > MAX_PROJECT_ARCHIVE_BYTES) throw new Error("Project archive exceeds 10 MiB");
  return result;
}
export function projectArchive(kind: ProjectArchive["kind"], snapshot: { name: string; source: string; server_source?: string | null; project?: unknown }): ProjectArchive {
  return parseProjectArchive({ format: PROJECT_ARCHIVE_FORMAT, version: 1, kind, name: snapshot.name, source: snapshot.source, server_source: snapshot.server_source ?? null, project: normalizeProject(snapshot.project) });
}
