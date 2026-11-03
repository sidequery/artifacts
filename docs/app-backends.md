# App backends and SQLite

Add a TypeScript backend when your React app needs to store data, call an external
API with a secret, or handle HTTP requests. Backends run with the full Artifacts
application on Cloudflare or celld, including the local `artifacts host`.
The file-based `artifacts web` preview does not execute backends.

Ask your coding agent to read `artifact_guide` and create an app with a server,
or use the [counter example](../examples/counter.artifact.server.ts).
Browser code calls the backend through `artifactFetch`; each app has its own
persistent SQLite database. Saving or restoring source keeps the current data.
An artifact can also have a server and no UI; that is an
[endpoint](scripts.md), and it uses the same server contract.

## Server source and storage

A hosted artifact may contain two source snapshots: browser React source and an
optional server. Server source default-exports a Workers handler,
`export default { fetch(request, env, ctx) }`, typed as
`ExportedHandler<ServerEnv>`. Each artifact with a server gets one native SQLite
database. Different artifact names get separate databases; multiple tabs and server
restarts use the same database. Use `env.sql.exec(sql, ...bindings)` with `?`
placeholders for values, and `.toArray()` or `.one()` to read the cursor. Use
`env.storage.kv.get/put/delete` for key/value data and
`env.storage.transactionSync(() => { ... })` for synchronous SQL/KV transactions.
Artifacts does not add a database abstraction or query-hook layer.

Servers written before handlers were supported export `ArtifactServer`, a Durable
Object class from `cloudflare:workers`, with a normal `fetch(request)` method, and
use `this.ctx.storage` and `this.env.secrets`. That form remains supported. Both
forms run in the same Durable Object facet, so rewriting a class as a handler keeps
the artifact's database.

### Application schema migrations

Artifacts does not provide a migration command or automatic application-schema runner.
The sample initializes tables with `create table if not exists`; that does not
upgrade an existing table. For schema changes, keep a schema version in the artifact
database, check it during server initialization, and apply pending changes together
with the new version in one `env.storage.transactionSync`. Complete that work
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
Cloudflare limits each request to 30 seconds CPU and 50 subrequests; the pinned
celld runtime does not enforce these per-worker budgets. Console output, request
summaries and errors are kept as the latest 100 log entries; read them with
`artifact_logs` or from a run in the gallery's run history. Secret values are
redacted from captured output.

Read secrets from `env.secrets.NAME` (`this.env.secrets.NAME` in an
`ArtifactServer extends DurableObject<ArtifactEnv>` class). Configure values in the gallery's **Secrets** tab or with
`artifact_secrets({name, secrets: {API_TOKEN: "value", OLD_TOKEN: null}})`;
omitting `secrets` lists names only. Up to 32 keys, 4 KiB per value, and 32 KiB
total are supported. Secrets belong to the artifact, outside source history,
exports and app storage. Source edits, restores and library moves retain them;
remixes and imports start empty. Secret updates reload the server without
resetting its database. Never include secrets in app responses.

```ts
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/customer") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return fetch("https://api.example.com/customer", {
      headers: { authorization: `Bearer ${env.secrets.API_TOKEN}` },
    });
  },
} satisfies ExportedHandler<ServerEnv>;
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

