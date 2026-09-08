import { DurableObject } from "cloudflare:workers";
import type { CanvasFile, CanvasFileRequest } from "../src/sdk/files";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const GRANT_LIFETIME_MS = 5 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TRANSFER_PATH = /^\/api\/canvas\/files\/transfer\/([0-9a-f]{64})\/([0-9a-f-]{36})$/;
type Grant = { method: "PUT" | "GET"; file: CanvasFile; expires: number };
type FileReply = { files: CanvasFile[]; cursor?: string } | { file: CanvasFile; path: string; expires: string } | { deleted: true };
export type FilesEnv = { FILES: R2Bucket };

export class CanvasFileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503 = 400) { super(message); }
}

export function validateFileRequest(value: unknown): asserts value is CanvasFileRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanvasFileError("Invalid file request");
  const input = value as Record<string, unknown>;
  const allowed: Record<string, string[]> = { list: ["operation", "cursor"], upload: ["operation", "name", "size", "type"], download: ["operation", "id"], delete: ["operation", "id"] };
  if (typeof input.operation !== "string" || !Object.hasOwn(allowed, input.operation)
    || Object.keys(input).some(key => !allowed[input.operation as string]!.includes(key))) throw new CanvasFileError("Invalid file request");
  if (input.operation === "list") {
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 2048)) throw new CanvasFileError("Invalid file cursor");
  } else if (input.operation === "upload") {
    if (typeof input.name !== "string" || !input.name.trim() || input.name === "." || input.name === ".."
      || /[/\\\u0000-\u001f\u007f]/.test(input.name) || new TextEncoder().encode(input.name).byteLength > 255) throw new CanvasFileError("File name must be 1–255 bytes without slashes or control characters");
    if (typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 0) throw new CanvasFileError("Invalid file size");
    if (input.size > MAX_FILE_BYTES) throw new CanvasFileError("File exceeds 25 MiB", 413);
    if (typeof input.type !== "string" || input.type.length > 255 || /[^\x20-\x7e]/.test(input.type)) throw new CanvasFileError("Invalid file content type");
  } else if (typeof input.id !== "string" || !ID.test(input.id)) throw new CanvasFileError("Invalid file ID");
}

function metadata(object: R2Object): CanvasFile {
  return { id: object.key.split("/").at(-1)!, name: object.customMetadata?.name ?? "download",
    size: object.size, type: object.httpMetadata?.contentType ?? "application/octet-stream", uploaded: object.uploaded.toISOString() };
}

function transferHeaders(): Headers {
  return new Headers({ "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS",
    "access-control-allow-headers": "content-type", "access-control-expose-headers": "content-type, content-length, content-disposition, etag",
    "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
}

/** Native R2 stays in the trusted host. One object owns one library/workspace/canvas,
 * including historical previews; caller-provided filenames never select storage keys. */
export class CanvasFiles extends DurableObject<FilesEnv> {
  constructor(ctx: DurableObjectState, env: FilesEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("create table if not exists file_grants (token text primary key, expires integer not null, value text not null)");
    ctx.storage.sql.exec("create table if not exists file_uploads (id text primary key, canceled integer not null, expires integer not null)");
  }

  private prefix() { return `canvases/${this.ctx.id.toString()}/`; }
  private key(id: string) { return this.prefix() + id; }

  async request(input: CanvasFileRequest): Promise<FileReply> {
    validateFileRequest(input);
    if (!this.env.FILES) throw new CanvasFileError("Canvas file storage is not configured", 503);
    if (input.operation === "list") {
      const result = await this.env.FILES.list({ prefix: this.prefix(), limit: 100, include: ["customMetadata", "httpMetadata"], ...(input.cursor ? { cursor: input.cursor } : {}) });
      const pending = new Set(this.ctx.storage.sql.exec<{ id: string }>("select id from file_uploads").toArray().map(row => row.id));
      return { files: result.objects.filter(object => object.key.startsWith(this.prefix()) && !pending.has(object.key.slice(this.prefix().length))).map(metadata), ...(result.truncated ? { cursor: result.cursor } : {}) };
    }
    if (input.operation === "delete") {
      // Record cancellation before yielding. An in-flight PUT may publish after
      // delete returns, so its completion must also remove the canceled object.
      this.ctx.storage.sql.exec("update file_uploads set canceled = 1 where id = ?", input.id);
      this.ctx.storage.sql.exec("delete from file_grants where json_extract(value, '$.file.id') = ?", input.id);
      await this.env.FILES.delete(this.key(input.id));
      return { deleted: true };
    }
    const file = input.operation === "upload"
      ? { id: crypto.randomUUID(), name: input.name, size: input.size, type: input.type || "application/octet-stream", uploaded: new Date().toISOString() }
      : await this.info(input.id);
    const expires = Date.now() + GRANT_LIFETIME_MS;
    this.ctx.storage.sql.exec("delete from file_grants where expires <= ?", Date.now());
    if (this.ctx.storage.sql.exec<{ n: number }>("select count(*) as n from file_grants").one().n >= 128) throw new CanvasFileError("Too many pending file transfers; retry after five minutes", 429);
    const token = crypto.randomUUID();
    const grant: Grant = { method: input.operation === "upload" ? "PUT" : "GET", file, expires };
    this.ctx.storage.sql.exec("insert into file_grants values (?, ?, ?)", token, expires, JSON.stringify(grant));
    await this.scheduleCleanup();
    return { file, path: `/api/canvas/files/transfer/${this.ctx.id.toString()}/${token}`, expires: new Date(expires).toISOString() };
  }

  private async info(id: string): Promise<CanvasFile> {
    if (this.ctx.storage.sql.exec("select id from file_uploads where id = ?", id).toArray().length) throw new CanvasFileError("File not found", 404);
    const object = await this.env.FILES.head(this.key(id));
    if (!object) throw new CanvasFileError("File not found", 404);
    return metadata(object);
  }

  private async scheduleCleanup() {
    const next = this.ctx.storage.sql.exec<{ expires: number | null }>("select min(expires) as expires from (select expires from file_grants union all select expires from file_uploads)").one().expires;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    this.ctx.storage.sql.exec("delete from file_grants where expires <= ?", Date.now());
    // Reclaim interrupted uploads after ten minutes. A still-running PUT treats
    // a missing state row as cancellation when it completes.
    const stale = this.ctx.storage.sql.exec<{ id: string }>("select id from file_uploads where expires <= ?", Date.now()).toArray();
    for (const { id } of stale) {
      this.ctx.storage.sql.exec("update file_uploads set canceled = 1 where id = ?", id);
      await this.env.FILES.delete(this.key(id));
      this.ctx.storage.sql.exec("delete from file_uploads where id = ?", id);
    }
    await this.scheduleCleanup();
  }

  async fetch(request: Request): Promise<Response> {
    const headers = transferHeaders();
    try {
      const match = new URL(request.url).pathname.match(TRANSFER_PATH);
      if (!match || match[1] !== this.ctx.id.toString() || !ID.test(match[2]!)) throw new CanvasFileError("Transfer not found", 404);
      const row = this.ctx.storage.sql.exec<{ value: string }>("select value from file_grants where token = ? and expires > ?", match[2]!, Date.now()).toArray()[0];
      if (!row) throw new CanvasFileError("File transfer expired or already used", 404);
      const grant = JSON.parse(row.value) as Grant;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== grant.method && !(grant.method === "GET" && request.method === "HEAD")) {
        headers.set("allow", grant.method === "GET" ? "GET, HEAD, OPTIONS" : "PUT, OPTIONS");
        return new Response("Method not allowed", { status: 405, headers });
      }
      if (grant.method === "PUT") {
        // HTTP bodies retain their native known length, so R2 can stream without
        // buffering or FixedLengthStream shims that differ between runtimes.
        const length = request.headers.get("content-length");
        if (length === null || !/^\d+$/.test(length) || Number(length) !== grant.file.size) throw new CanvasFileError("Upload size does not match its transfer grant");
        // Consume before yielding: two concurrent PUTs cannot overwrite one file.
        this.ctx.storage.sql.exec("delete from file_grants where token = ?", match[2]!);
        this.ctx.storage.sql.exec("insert into file_uploads values (?, 0, ?)", grant.file.id, Date.now() + 10 * 60 * 1000);
        await this.scheduleCleanup();
        let settled = false;
        try {
          const object = await this.env.FILES.put(this.key(grant.file.id), request.body ?? new Uint8Array(), {
            httpMetadata: { contentType: grant.file.type }, customMetadata: { name: grant.file.name },
          });
          const state = this.ctx.storage.sql.exec<{ canceled: number }>("select canceled from file_uploads where id = ?", grant.file.id).toArray()[0];
          if (state?.canceled !== 0 || object.size !== grant.file.size) {
            await this.env.FILES.delete(this.key(grant.file.id));
            settled = true;
            throw new CanvasFileError(state?.canceled !== 0 ? "Upload was canceled" : "Upload size does not match its transfer grant", 409);
          }
          settled = true;
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify({ file: metadata(object) }), { status: 201, headers });
        } finally {
          if (settled) this.ctx.storage.sql.exec("delete from file_uploads where id = ?", grant.file.id);
          else {
            // R2 may have committed despite a transfer/cleanup error. Keep it
            // hidden and retry cleanup; never lose a cancellation on failure.
            this.ctx.storage.sql.exec("insert into file_uploads values (?, 1, ?) on conflict(id) do update set canceled = 1, expires = excluded.expires", grant.file.id, Date.now() + 60_000);
            await this.scheduleCleanup();
          }
        }
      }
      const object = request.method === "HEAD" ? await this.env.FILES.head(this.key(grant.file.id)) : await this.env.FILES.get(this.key(grant.file.id));
      if (!object) throw new CanvasFileError("File not found", 404);
      headers.set("content-type", grant.file.type);
      headers.set("content-length", String(object.size));
      headers.set("etag", object.httpEtag);
      headers.set("content-disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(grant.file.name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
      // Even if a client ignores attachment, uploaded HTML has no host authority.
      headers.set("content-security-policy", "sandbox; default-src 'none'");
      return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, { headers });
    } catch (error) {
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ error: error instanceof CanvasFileError ? error.message : "File transfer failed" }), { status: error instanceof CanvasFileError ? error.status : 500, headers });
    }
  }
}
