# Cloudflare deployment and local development

Artifacts runs as a Worker with SQLite Durable Objects, static assets and a Dynamic
Worker Loader. Generated React executes in the browser sandbox. Optional native
artifact servers execute in isolated Durable Object facets. The server uses
`@cloudflare/worker-bundler` 0.2.3 and the same TypeScript 5.9.3 diagnostics as
the local Bun adapter; it does not install Bun packages while handling requests.

This runtime is experimental. Local workerd integration is tested, including
real MCP clients and Chromium, but production CPU/memory qualification is still
outstanding. Use Workers Paid: runtime compilation and Dynamic Workers are not
suited to the Free plan. Compiles are serialized within each isolate, with
at most eight pending requests. This reduces peak memory, but is not proof of
compliance with production's 128 MiB limit.

## Local workerd stack

```sh
bun install --frozen-lockfile
bun run dev:cloudflare
```

Wrangler runs workerd, local SQLite Durable Objects, and the real gallery assets
on `http://127.0.0.1:4785`. State persists under `.wrangler/state`. The checked-in
`AUTH_MODE=access` keeps the existing development behavior: the explicit local
flag bypasses Access only for loopback hosts, while production never enables that
bypass. Better Auth mode always requires a real provider sign-in and a migrated
local D1 database; see [Better Auth mode](#better-auth-mode).

In another terminal:

```sh
bun run seed:cloudflare
# Optional separate workspace:
bun run seed:cloudflare research
```

Open `http://127.0.0.1:4785` or `http://127.0.0.1:4785/?workspace=research`.
Configure an HTTP MCP client with `http://127.0.0.1:4785/mcp` (append the same
`workspace` query parameter when needed). The seed command creates/replaces the
`overview` draft with the checked-in example.

```sh
bun run test:cloudflare
bun run typecheck:cloudflare
```

The suite builds the compiler and application, then exercises real workerd
compilation, SQLite history, signed Access JWT verification, official MCP HTTP
transport, browser interactions, protected assets, origin checks and limits.
Chromium must be installed with `bun x playwright install chromium`.
`bun run build:cloudflare` is a dry-run and creates no Cloudflare resources.

## Deploy into your own or a shared account

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsidequery%2Fartifacts)
uses Cloudflare's account selection and repository setup flow. Choose the
personal or shared account that should own the Worker, Durable Object storage,
and billing. The deploying identity must have permission to deploy there.
This is a public self-deploy project; no central Artifacts account is required.

For a manual deployment, authenticate with `bun x wrangler login`, verify the
selected identity using `bun x wrangler whoami`, then run
`CLOUDFLARE_ACCOUNT_ID=<target-account-id> bun run deploy:cloudflare`.
The account ID selects infrastructure ownership; it is not a user credential.
Set a distinct `name` in `wrangler.jsonc` if the account needs multiple instances.

Deployment authorization and application sign-in are separate. Configure
[authentication and access](authentication.md) before using the gallery or MCP
on a network deployment. That guide covers provider credentials, database
migrations, admission rules, library permissions, and troubleshooting.

### Cloudflare Access mode

The checked-in configuration defaults to `AUTH_MODE="access"`. Set up an Access
application and user policy, enable managed OAuth for MCP, and configure
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Follow the
[Cloudflare Access setup](authentication.md#set-up-cloudflare-access).

### Better Auth mode

Set `AUTH_MODE="better-auth"` to host provider sign-in in this deployment.
Configure the public origin, an identity provider, a deployment secret, an
admission rule, and an `AUTH_DB` D1 binding. Apply the checked-in migrations
before serving traffic. Follow the
[Better Auth setup](authentication.md#set-up-better-auth), including
[local development](authentication.md#local-better-auth-development).

### Connect users and agents

Open the deployed hostname for the gallery. Add `https://<instance-hostname>/mcp`
to an OAuth-capable MCP client for a personal library, or append
`?library=team&workspace=<workspace>` for the shared team library. See
[connection instructions and supported credentials](authentication.md#connect-to-an-existing-deployment).
Before switching modes on an existing deployment, read
[the identity migration note](authentication.md#changing-authentication-modes-and-upgrading).

Hosted MCP supports inline Artifact views, raw-source reads/writes/guarded edits,
semantic diagnostics, history, archived views and restore. It rejects the local
`herdr` pane target. `useArtifactState` interactions remain local to their view;
requests made with `artifactFetch` can mutate durable server state. Raw source and
initial-state snapshots and compiled client/server bundles are persisted.
Successful writes, edits and restores prepare the compiled artifact before
activating the revision. Page loads, gallery previews, MCP opens and backend
requests retrieve that artifact without typechecking or compiling. The revision
keeps its bundled SDK/browser libraries across process restarts and deployment
upgrades; later edits use the current compiler and dependency configuration.
Sources are limited to 256 KiB, serialized state to 64 KiB, and MCP requests to
1 MiB. Large or particularly complex TypeScript can still exceed runtime budgets.

When upgrading a deployment that previously stored only source, explicitly
backfill the required revisions through its authenticated MCP endpoint before
reopening their links. List `artifact_history`, then call
`artifact_compile({version_id: "..."})` for each revision to retain as a runnable
view. `artifact_compile({name: "..."})` prepares a working draft. Already compiled
revisions reuse their pinned output. This does not edit source, rename links,
execute backends, or erase history. Invalid historical source remains readable
but cannot produce a runnable artifact until corrected. A missing artifact gives
an actionable compile diagnostic; a read never starts an implicit build.

## Native artifact servers and storage

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

The private library selects both source history and backend storage from the
verified Access subject. The team library selects one shared source history and
backend for all members authorized by the deployment's Access policy. Workspaces
and artifact names further partition storage; neither can cross the private/team
boundary. The local Bun CLI, stdio MCP server and gallery have no artifact-server
backend. Their browser views can use ordinary local artifact interactions, but
`artifactFetch` rejects with an unavailable error.

## Optional celld compatibility

[celld](https://github.com/denoland/celld) is a Cloudflare-compatible runtime.
Wrangler/workerd remains the default Cloudflare development path. Artifact also
targets the released celld v0.5.0 with integration tests for the built application, including
generated `ArtifactServer` execution on raw SQL and KV facets.
The generated config preserves the `worker_loaders` binding used by celld 0.5.0;
the removed `CELLD_WORKER_LOADER` environment variable must no longer be set.
The generated config sets `ARTIFACTS_RUNTIME=celld`, which omits the unsupported
script CPU and subrequest limits. celld does not enforce these per-script budgets.
Cloudflare retains the 30,000 ms CPU and 50 subrequest limits by default; do not
set this variable to `celld` on Cloudflare. See the [upstream compatibility notes](https://github.com/denoland/celld/blob/v0.5.0/docs/cloudflare-compat.md#dynamic-workers).

```sh
bun run dev:celld
bun run test:celld
```

`dev:celld` builds and serves the full application on
`http://127.0.0.1:4786`. It uses `celld` from `PATH`, or the executable selected
by `CELLD_BIN`; `CELLD_PORT` changes the port and `CELLD_ESBUILD` selects the
esbuild executable. Development state persists in the ignored `.celld/dev`
directory. Seed the counter pair with:

```sh
ARTIFACTS_MCP_URL=http://127.0.0.1:4786/mcp bun run seed:cloudflare default counter
```

`test:celld` copies the built bundle and assets into a temporary directory with
temporary celld state. It exercises the native counter, code updates, gallery
and browser counter, then restarts celld and verifies SQL/KV data survived.
It also runs the same signed OIDC fixture and MCP OAuth browser flow as workerd:
discovery, registration, consent, two-user personal isolation, shared team
state, provider admission, refresh and sign-out revocation.
Install Chromium with `bun x playwright install chromium` before running it.
The worker-bundler patch in this checkout
statically imports esbuild's WASM module and initializes its browser global
before bundler startup; both are required by celld v0.4.1.
Passing the compatibility test does not add D1, R2 or other outer-Worker
bindings to generated artifact servers: their supported state remains the raw
Durable Object SQL/KV facets described above.

When `AUTH_DB` is present in `wrangler.jsonc`, the generated celld configuration
carries that D1 binding. celld v0.4.1 can run the checked-in Better Auth schema in
local D1 and preserve it across a restart. Its `celld d1 migrations apply` command
targets deployed bucket storage rather than the local development database, so
the Artifacts celld integration uses a temporary bootstrap Worker for local schema
setup. This fixture exercises the complete OAuth/session flow on celld v0.5.0;
ordinary `dev:celld` does not apply auth migrations automatically. Use
Wrangler/workerd's local migration command for routine Better Auth development.

## Platform references

- [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
- [Access managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)

Hosted list/history results contain at most 100 entries and a `next_offset`.
Pass that value as `offset` to continue. `artifact_version` returns at most 20
serve events and `next_events_offset`; pass it as `events_offset` to retrieve
older events. A null continuation means the end. Gallery pages are loaded
sequentially. Pagination bounds individual Worker responses without deleting
history; concurrent writes may shift offset-based pages, so refresh if needed.

## Existing deployment identities

The application is named Artifacts. The checked-in Worker name `canvas`, R2 bucket
`canvas-files`, historical Durable Object class exports and migration tags retain
their deployed identities so an upgrade continues using the same databases and
files. New source uses `ArtifactLibrary`, `ArtifactBackend`, and `ArtifactFiles`;
legacy exports remain aliases. Do not rename provisioned resources as part of a
normal code update. Existing OAuth clients with the `canvas` scope remain valid;
new clients request `artifacts`.
