# App backends and SQLite

Add a TypeScript backend when your React app needs to store data, call an external
API with a secret, or handle HTTP requests. Backends run with the full Artifacts
application on Cloudflare or celld, including the local `artifacts host`.
The file-based `artifacts web` preview does not execute backends.

Ask your coding agent to read `artifact_guide` and create an app with a server,
or use the [counter example](../examples/counter.artifact.server.ts).
Browser code calls the backend through `artifactFetch`; each app has its own
persistent SQLite database. Saving or restoring source keeps the current data.

## Server source and storage

A hosted artifact may contain two source snapshots: browser React source and an
optional native server. Server source must export `ArtifactServer`, a Durable
Object class from `cloudflare:workers`, with a normal `fetch(request)` method.
Each artifact with a server gets one native SQLite database. Different artifact names
get separate databases; multiple tabs and server restarts use the same database. Use `this.ctx.storage.sql.exec(sql, ...bindings)`
with `?` placeholders for values, and `.toArray()` or `.one()` to read the cursor.
Use `this.ctx.storage.kv.get/put/delete` for key/value data and
`this.ctx.storage.transactionSync(() => { ... })` for synchronous SQL/KV transactions. Artifacts does
not add a database abstraction or query-hook layer.

### Application schema migrations

Artifacts does not provide a migration command or automatic application-schema runner.
The sample initializes tables with `create table if not exists`; that does not
upgrade an existing table. For schema changes, keep a schema version in the artifact
database, check it during server initialization, and apply pending changes together
with the new version in one `this.ctx.storage.transactionSync`. Complete that work
before serving requests. Saving server source only stores and validates code;
initialization and migrations run when the updated server is next requested.

Prefer additive changes that remain compatible with earlier source revisions.
Restoring source does not roll back schema or data, and archived previews can run
older code against the current database. Test changes on a separate artifact/database
before applying them to populated data. The deployment-level Durable Object migration
provisions the storage classes; it does not manage user tables inside an artifact.

### Server capabilities

Generated servers do not receive the outer Worker's ordinary bindings. In
particular, do not assume D1, R2 or custom environment bindings are available.
The server supports outbound `fetch` and Workers-compatible `node:` imports.
Persistent application data uses the artifact Durable Object's own SQL/KV storage.
The same CPU and subrequest limits as scripts apply on Cloudflare (30 seconds CPU,
50 subrequests); the pinned celld runtime does not enforce these per-worker budgets.

Declare `ArtifactServer extends DurableObject<ArtifactEnv>` to use
`this.env.secrets.NAME`. Configure values in the gallery's **Secrets** tab or with
`artifact_secrets({name, secrets: {API_TOKEN: "value", OLD_TOKEN: null}})`;
omitting `secrets` lists names only. Up to 32 keys, 4 KiB per value, and 32 KiB
total are supported. Secrets belong to the artifact, outside source history,
exports and app storage. Source edits, restores and library moves retain them;
remixes and imports start empty. Secret updates reload the server without
resetting its database. Never include secrets in app responses.

```ts
import { DurableObject } from "cloudflare:workers";

export class ArtifactServer extends DurableObject<ArtifactEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/customer") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return fetch("https://api.example.com/customer", {
      headers: { authorization: `Bearer ${this.env.secrets.API_TOKEN}` },
    });
  }
}
```

Direct `/slug/api/*` URLs preserve native HTTP streaming and support larger
bodies, subject to runtime/proxy limits. `artifactFetch` and MCP
`artifact_request` use buffered envelopes capped at 256 KiB. See
[HTTP routing](routing.md#http-apis) for path and credential handling.

Browser code imports `artifactFetch` from `sidequery/artifacts`:

```ts
const response = await artifactFetch("/counter", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount: 1 }),
});
if (!response.ok) throw new Error(`Request failed (${response.status})`);
const data = await response.json();
```

`artifactFetch(path, init)` uses native `Request` normalization, including JSON,
`FormData`, URL-encoded and binary bodies, and returns a native `Response`.
The host transports method, normalized headers and a base64 body to
`artifact_request`; artifact code sees no service URL or bearer secret. Paths are
resolved as HTTP paths, fragments are omitted, and cross-origin or
protocol-relative URLs are rejected. Request and response bodies are each
limited to 256 KiB. `HEAD`, `204`, `205` and `304` responses have null bodies.

Create or replace a pair with hosted `artifact_write({name, contents, server})`.
If an artifact already has server source, omitting `server` preserves it; pass
`server: null` to remove the server without deleting stored data. Read or edit
one side with `artifact_read({name, part: "client" | "server"})` and
`artifact_edit({name, part, edits, expected_hash?})`. Typecheck and compile cover
both sources when a server is present. The checked-in
[`counter.artifact.tsx`](../examples/counter.artifact.tsx) and
[`counter.artifact.server.ts`](../examples/counter.artifact.server.ts) demonstrate
the complete pair. Seed it into workerd with:

```sh
bun run seed:cloudflare default counter
```

History captures client and server source as one revision. Restore changes both
sources together. Database contents are not part of a revision: they remain live
when server code is edited, removed, re-added or restored. An archived server
version runs its archived code against that artifact's current database. The
backend identity includes library scope, workspace and artifact name, so code
changes restart the generated facet without changing its durable storage.

The personal library selects source history and backend storage from the
signed-in user's identity. The team library shares source history and backend
storage with everyone admitted by the deployment's sign-in policy, whether it
uses Better Auth or Cloudflare Access. Workspaces
and artifact names further partition storage; neither can cross the private/team
boundary. The local Bun CLI, stdio MCP server and gallery have no artifact-server
backend. Their browser views can use ordinary local artifact interactions, but
`artifactFetch` rejects with an unavailable error.

