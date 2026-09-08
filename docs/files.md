# Canvas files

Hosted canvases and the managed local celld server support persistent files without
requiring canvas server code. Import `canvasFiles` from `sidequery/canvas`:

```tsx
const file = await canvasFiles.upload(selectedFile);
const page = await canvasFiles.list(); // { files, cursor? }, up to 100 entries
const next = page.cursor ? await canvasFiles.list({ cursor: page.cursor }) : null;
const contents = await canvasFiles.read(file.id); // Blob
await canvasFiles.download(file.id); // ask the host to start a browser download
await canvasFiles.delete(file.id);
```

`upload` accepts a `File` or `Blob`, with optional `{ name, signal }`. `read` accepts
`{ signal }`. Each file has an opaque `id`, original `name`, byte `size`, MIME `type`,
and ISO `uploaded` timestamp. Uploads create new files even when names match. Each
file may be at most 25 MiB. Empty files are supported. Upload failures require a
new upload request; multipart/resumable uploads are not part of this API.

Files belong to **library + workspace + canvas name**, matching the canvas's
database identity. Private libraries isolate users; the team library shares files.
Source changes, archived previews, source restores, and URL renames all use the
same live files. Files are not embedded in source history or source downloads.
Deleting a file does not change the canvas source. Treat deletion as permanent.

Public standalone canvases can list and download their files, but cannot upload
or delete through their public URL. Publishing a canvas therefore exposes its
files for reading. Private standalone views use the same library authorization
as the gallery. Plain file-based previews without the hosted/managed server do
not have persistent file storage; their SDK calls report that files are unavailable.

The `canvas_files` MCP tool accepts `{ name?, version_id?, request }`. Requests are
`{ operation: "list", cursor? }`, `{ operation: "upload", name, size, type }`, or
`{ operation: "download" | "delete", id }`. Upload/download return
`{ file, url, expires }`; list returns `{ files, cursor? }`. Upload bytes using HTTP
PUT with exactly the declared `Content-Length`; the response is `201 { file }`.
Download with HTTP GET. File bytes never go through MCP or `canvasFetch`'s 256 KiB
JSON bridge. The SDK performs transfers automatically, without sending cookies.

Transfer URLs are bearer capabilities valid for five minutes. An upload URL is
single-use; a download URL can be reused until it expires or the file is deleted.
Do not publish or log these URLs. Restricting a formerly public canvas does not
revoke already issued download URLs immediately; they expire within five minutes.
Downloads are forced attachments with a sandbox policy, including uploaded HTML.
The gallery and standalone wrapper initiate downloads outside the canvas iframe;
MCP views ask the chat host to open the download link. The host may decline it.

## Deployment

The canonical Wrangler configuration binds `FILES` to the `canvas-files` R2 bucket
and adds the SQLite `CanvasFiles` Durable Object (`FILE_BACKENDS`). Create the R2
bucket before deploying (`bun x wrangler r2 bucket create canvas-files`), or change
the bucket name to a deployment-owned bucket. The `v4` Durable Object migration
creates the supervisor class; it does not alter existing canvas databases.

With celld, the same `r2_buckets` binding uses the runtime's object store. Local
`canvas server` persists files under its existing `.celld/dev` state directory;
no R2 account or credentials are required for local use. Generated `CanvasServer`
isolates do not receive the bucket or transfer credentials.

MCP file transfers need the deployment origin in the resource's `connectDomains`;
the server advertises it when file storage is configured. Gallery and standalone
frames allow connections only to the transfer path. If Cloudflare Access or a
reverse proxy protects every path, exempt `/api/canvas/files/transfer/*` from its
interactive login requirement: those routes validate their own short-lived grants.
Keep all management and grant-creation routes protected. Configure proxy upload
limits to accept 25 MiB.

See [the file canvas example](../examples/files.canvas.tsx).
