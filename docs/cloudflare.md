# Cloudflare deployment and local development

Canvas runs as a Worker with SQLite Durable Objects, static assets and a Dynamic
Worker Loader. Generated React executes in the browser sandbox. Optional native
canvas servers execute in isolated Durable Object facets. The server uses
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

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsidequery%2Fcanvas)
uses Cloudflare's account selection and repository setup flow. Choose the
personal or shared account that should own the Worker, Durable Object storage,
and billing. The deploying identity must have permission to deploy there.
This is a public self-deploy project; no central Canvas account is required.

For a manual deployment, authenticate with `bun x wrangler login`, verify the
selected identity using `bun x wrangler whoami`, then run
`CLOUDFLARE_ACCOUNT_ID=<target-account-id> bun run deploy:cloudflare`.
The account ID selects infrastructure ownership; it is not a user credential.
Set a distinct `name` in `wrangler.jsonc` if the account needs multiple instances.

Deployment authorization and application sign-in are separate. The native deploy
flow provisions the Worker, assets and configured SQLite Durable Object
migrations. Better Auth additionally requires a D1 database and its SQL migration.
Choose one application authentication mode in `wrangler.jsonc`:

- `AUTH_MODE = "access"` keeps the existing Cloudflare Access integration and is
  the checked-in default.
- `AUTH_MODE = "better-auth"` runs Better Auth in this Worker with the identity
  providers and D1 database owned by this deployment.

There is no central Canvas account or authentication service in either mode.

### Cloudflare Access mode

Configure Access before using the gallery or MCP server:

1. Enable Cloudflare Access for this Worker and every hostname that reaches it,
   including its `workers.dev` URL and any custom domains or preview URLs.
2. Add the Cloudflare identity provider and a policy granting the intended
   account members access. A shared-account deployment can authorize the team
   to use the same gallery and centralized MCP endpoint.
3. Enable Access managed OAuth for the application so MCP clients can use the
   standard OAuth sign-in flow. Use the complete Worker hostname as the
   application's coverage, including `/mcp` and gallery assets.
4. Set `ACCESS_TEAM_DOMAIN` to the team's `name.cloudflareaccess.com` domain and
   `ACCESS_AUD` to this Access application's audience, then redeploy. These are
   identifiers, not secrets. Keep `ENVIRONMENT` set to `production`.

Without these variables, Access mode returns 503. With them, every protected
request must have an RS256 Access assertion with the matching issuer and audience.
Managed OAuth validates the MCP client's token at the edge and forwards the
signed assertion. Raw identity headers and unsigned JWT payloads are not trusted.
`/health` is a public runtime check and exposes no library data.

### Better Auth mode

Better Auth is hosted at the Canvas deployment's own `/api/auth` routes and uses
the `AUTH_DB` D1 binding for users, sessions, OAuth grants, signing keys and rate
limits. It accepts provider sign-in only; email/password registration is disabled.

Set `BETTER_AUTH_URL` to the stable, public origin users and MCP clients actually
open, for example `https://canvas.example.com`. It must be an HTTPS origin with no
path, query or fragment. HTTP is accepted only for loopback development hosts.
For example, production `vars` can select the mode, canonical URL and an admission
rule:

```json
{
  "ENVIRONMENT": "production",
  "AUTH_MODE": "better-auth",
  "BETTER_AUTH_URL": "https://canvas.example.com",
  "BETTER_AUTH_ALLOWED_DOMAINS": "example.com",
  "BETTER_AUTH_TRUSTED_IP_HEADER": "cf-connecting-ip"
}
```

Register provider callbacks against the same origin:

```text
https://canvas.example.com/api/auth/callback/google
https://canvas.example.com/api/auth/callback/github
https://canvas.example.com/api/auth/callback/company
```

Generate a deployment-specific secret of at least 32 characters and store it with
the provider credentials as a Worker secret. Do not commit these values:

```sh
openssl rand -base64 32
bun x wrangler secret put BETTER_AUTH_SECRET
bun x wrangler secret put BETTER_AUTH_SOCIAL_PROVIDERS
```

`BETTER_AUTH_SOCIAL_PROVIDERS` is JSON passed through to Better Auth's native
`socialProviders` option. These are complete Google and GitHub shapes; replace
the placeholders with one or both provider applications:

```json
{"google":{"clientId":"<google-client-id>","clientSecret":"<google-client-secret>"}}
```

```json
{"github":{"clientId":"<github-client-id>","clientSecret":"<github-client-secret>"}}
```

You may combine them in one object or use any other social provider supported by
the installed Better Auth version. For a discovery-based OpenID Connect provider,
set `BETTER_AUTH_OIDC_PROVIDERS` to a JSON array and store it as a Worker secret:

```json
[{"providerId":"company","name":"Company SSO","discoveryUrl":"https://id.example.com/.well-known/openid-configuration","clientId":"<oidc-client-id>","clientSecret":"<oidc-client-secret>","scopes":["openid","profile","email"],"requireIdTokenVerification":true}]
```

```sh
bun x wrangler secret put BETTER_AUTH_OIDC_PROVIDERS
```

Both JSON settings are deployment configuration, so the Canvas server and sign-in
page do not contain a fixed provider list. If a provider needs callbacks, custom
profile mapping or another Better Auth plugin, extend `teamProviderOptions` in
[`cloudflare/team-auth.ts`](../cloudflare/team-auth.ts) with ordinary TypeScript.

Provider authentication and admission are separate. Configure at least one of:

- `BETTER_AUTH_ALLOWED_EMAILS`: comma- or whitespace-separated exact addresses.
- `BETTER_AUTH_ALLOWED_DOMAINS`: comma- or whitespace-separated email domains.
- `BETTER_AUTH_ALLOW_ALL_USERS=true`: admit every identity authenticated by the
  configured providers. Use this only when those providers already enforce the
  intended tenant or membership boundary.

The email and domain rules require the provider to return a verified email. With
no admission setting, no user is admitted. Provider hints such as Google's hosted
domain can narrow provider sign-in, but do not replace Canvas admission policy.

Auth endpoints use persistent database rate limits. On Cloudflare, the example
trusts the edge-owned `cf-connecting-ip` header. On celld, set
`BETTER_AUTH_TRUSTED_IP_HEADER` only to a header that a trusted proxy replaces;
otherwise omit it and requests share a per-path rate-limit bucket. Provider
access and refresh tokens are encrypted with Better Auth's native storage option.

Create the remote D1 database once. Access-mode deployments do not need this
resource. Add the returned ID and the checked-in migration directory to
`wrangler.jsonc` only when enabling Better Auth:

```sh
bun x wrangler d1 create canvas-auth --binding AUTH_DB
```

```json
{
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "canvas-auth",
      "database_id": "<database-id-returned-by-wrangler>",
      "migrations_dir": "cloudflare/migrations"
    }
  ]
}
```

Apply the checked-in migrations before the first Better Auth deployment:

```sh
bun x wrangler d1 migrations apply AUTH_DB --remote
bun run deploy:cloudflare
```

Apply migrations to workerd's local D1 before starting Better Auth locally:

```sh
bun x wrangler d1 migrations apply AUTH_DB --local
bun run dev:cloudflare
```

Put local values in the ignored `.dev.vars` file, including
`AUTH_MODE="better-auth"`, `BETTER_AUTH_URL="http://127.0.0.1:4785"`, a strong
`BETTER_AUTH_SECRET`, provider JSON and an admission rule. Future schema changes
use the same local/remote migration commands; do not regenerate or reapply the
initial migration as a replacement for migration history.
Runtime schema introspection is disabled because celld v0.4.1 rejects the
table-valued PRAGMA queries it uses. Apply migrations before serving traffic;
startup does not automatically detect or repair a missing or outdated schema.
Better Auth issues RS256 tokens on both runtimes because celld v0.4.1 cannot
verify its default Ed25519 signatures. Signing keys remain managed by Better
Auth in `AUTH_DB`. Auth instances are request-local to avoid celld's concurrent
handler hang when sharing an instance.
Generate future schema deltas with
`bun run scripts/generate-auth-migration.ts cloudflare/migrations/0002_description.sql`.

An OAuth-capable MCP client pointed at
`https://canvas.example.com/mcp?workspace=<workspace>` discovers this deployment's
authorization metadata, opens the same provider sign-in used by the gallery, and
asks the user to approve Canvas access. Browser sessions and MCP access tokens map
to the same Better Auth user ID. Signing out invalidates the session used to
authorize both surfaces.
Public MCP clients can register dynamically with PKCE. Desktop clients that omit
OIDC's optional `application_type` are recognized from their loopback or private
scheme callback; Better Auth still validates every callback URI. HTTPS web-client
registrations and explicit application types keep Better Auth's native behavior.

Open the deployed hostname for the gallery. Configure the centralized MCP server
URL as `https://<instance-hostname>/mcp?workspace=<workspace>` for a private library,
or `https://<instance-hostname>/mcp?library=team&workspace=<workspace>` for the team
library. You can register both endpoints in a client. The gallery has a **My
library / Team library** selector. Private is the default and is isolated by the
verified identity from the selected auth mode; passing a different user ID cannot
select another person's data. Every user admitted to the deployment can read and
edit the team library. Workspace names organize content inside a library and do
not grant access. Each deployment represents one team; use separate instances and
admission policies for unrelated teams. Infrastructure account administrators can
still administer the underlying storage.

Switching auth modes does not migrate private identities. Existing Access private
libraries remain keyed by the Access issuer and subject; Better Auth private
libraries use its user ID. The old data is not deleted, but Canvas does not infer
that an Access subject and a Better Auth account represent the same person. Plan
an explicit data migration before changing modes if users must retain the same
private library. The shared team-library key is unchanged, so authorized users in
the new mode continue to address the existing team library.

Hosted MCP supports inline Canvas views, raw-source reads/writes/guarded edits,
semantic diagnostics, history, archived views and restore. It rejects the local
`herdr` pane target. `useCanvasState` interactions remain local to their view;
requests made with `canvasFetch` can mutate durable server state. Raw source and
initial-state snapshots are persisted; compiled JavaScript is regenerated.
Sources are limited to 256 KiB, serialized state to 64 KiB, and MCP requests to
1 MiB. Large or particularly complex TypeScript can still exceed runtime budgets.

## Native canvas servers and storage

A hosted canvas may contain two source snapshots: browser React source and an
optional native server. Server source must export `CanvasServer`, a Durable
Object class from `cloudflare:workers`, with a normal `fetch(request)` method.
Its durable context exposes raw `ctx.storage.sql` and `ctx.storage.kv`; use those
APIs directly for relational data, transactions and key/value state. Canvas does
not add a database abstraction or query-hook layer.

Generated servers do not receive the outer Worker's ordinary bindings. In
particular, do not assume D1, R2 or custom environment bindings are available.
Global outbound access is disabled. The supported persistent boundary is the
canvas Durable Object's own SQL/KV storage.

Browser code imports `canvasFetch` from `herdr/canvas`:

```ts
const response = await canvasFetch("/counter", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount: 1 }),
});
if (!response.ok) throw new Error(`Request failed (${response.status})`);
const data = await response.json();
```

`canvasFetch(path, init)` uses native `Request` normalization, including JSON,
`FormData`, URL-encoded and binary bodies, and returns a native `Response`.
The host transports method, normalized headers and a base64 body to
`canvas_request`; canvas code sees no service URL or bearer secret. Paths are
resolved as HTTP paths, fragments are omitted, and cross-origin or
protocol-relative URLs are rejected. Request and response bodies are each
limited to 256 KiB. `HEAD`, `204`, `205` and `304` responses have null bodies.

Create or replace a pair with hosted `canvas_write({name, contents, server})`.
If a canvas already has server source, omitting `server` preserves it; pass
`server: null` to remove the server without deleting stored data. Read or edit
one side with `canvas_read({name, part: "client" | "server"})` and
`canvas_edit({name, part, edits, expected_hash?})`. Typecheck and compile cover
both sources when a server is present. The checked-in
[`counter.canvas.tsx`](../examples/counter.canvas.tsx) and
[`counter.canvas.server.ts`](../examples/counter.canvas.server.ts) demonstrate
the complete pair. Seed it into workerd with:

```sh
bun run seed:cloudflare default counter
```

History captures client and server source as one revision. Restore changes both
sources together. Database contents are not part of a revision: they remain live
when server code is edited, removed, re-added or restored. An archived server
version runs its archived code against that canvas's current database. The
backend identity includes library scope, workspace and canvas name, so code
changes restart the generated facet without changing its durable storage.

The private library selects both source history and backend storage from the
verified Access subject. The team library selects one shared source history and
backend for all members authorized by the deployment's Access policy. Workspaces
and canvas names further partition storage; neither can cross the private/team
boundary. The local Bun CLI, stdio MCP server and gallery have no canvas-server
backend. Their browser views can use ordinary local canvas interactions, but
`canvasFetch` rejects with an unavailable error.

## Optional celld compatibility

[celld](https://github.com/denoland/celld) is a Cloudflare-compatible runtime.
Wrangler/workerd remains the default Cloudflare development path. Canvas also
qualifies the released celld v0.4.1 against the built application, including
generated `CanvasServer` execution on raw SQL and KV facets.

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
CANVAS_MCP_URL=http://127.0.0.1:4786/mcp bun run seed:cloudflare default counter
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
bindings to generated canvas servers: their supported state remains the raw
Durable Object SQL/KV facets described above.

When `AUTH_DB` is present in `wrangler.jsonc`, the generated celld configuration
carries that D1 binding. celld v0.4.1 can run the checked-in Better Auth schema in
local D1 and preserve it across a restart. Its `celld d1 migrations apply` command
targets deployed bucket storage rather than the local development database, so
the Canvas celld integration uses a temporary bootstrap Worker for local schema
setup. This fixture qualifies the complete OAuth/session flow on celld v0.4.1;
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
Pass that value as `offset` to continue. `canvas_version` returns at most 20
serve events and `next_events_offset`; pass it as `events_offset` to retrieve
older events. A null continuation means the end. Gallery pages are loaded
sequentially. Pagination bounds individual Worker responses without deleting
history; concurrent writes may shift offset-based pages, so refresh if needed.
