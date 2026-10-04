# Deploy Artifacts to Cloudflare

Deploy the full Artifacts application to your own Cloudflare account: the browser
gallery, coding-agent connection, apps, scripts, and persistent storage.
You need a Cloudflare account with **Workers Paid**, a source checkout, and
Bun 1.4.0 or newer. Your account owns the resources and billing.

For sign-in, connect your team's existing service, such as Google, Microsoft
Entra ID, or Okta. Artifacts includes **Better Auth**, an authentication library
that connects to a broad range of OAuth/OIDC providers. You can instead use
**Cloudflare Access** to handle sign-in at Cloudflare's edge.

The Cloudflare runtime is experimental. Local integration tests cover workerd,
MCP, and the browser, but production CPU/memory qualification is still outstanding.
See [runtime limits](#runtime-limits) before production use.

- [Deploy the application](#deploy-into-your-own-or-a-shared-account)
- [Connect users and agents](#connect-users-and-agents)
- [Develop locally](#local-workerd-stack)
- [Build an app backend](app-backends.md)

## Deploy into your own or a shared account

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsidequery%2Fartifacts)
uses Cloudflare's account selection and repository setup flow. Choose the
personal or shared account that should own the Worker, Durable Object storage,
and billing. The deploying identity must have permission to deploy there.
This is a public self-deploy project; no central Artifacts account is required.

For a manual deployment, run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun x wrangler login
bun x wrangler whoami
```

Choose the target account, then configure sign-in using one of the options below.
In `wrangler.jsonc`, use a distinct Worker `name` if the account needs multiple
instances. Create the configured file-storage bucket in that account if it does
not already exist:

```sh
CLOUDFLARE_ACCOUNT_ID=<target-account-id> bun x wrangler r2 bucket create canvas-files
```

If you choose a different bucket name, update the `FILES` binding in
`wrangler.jsonc`. After completing authentication setup and any auth database
migrations, deploy:

```sh
CLOUDFLARE_ACCOUNT_ID=<target-account-id> bun run deploy:cloudflare
```

Use that same account for the authentication guide's Wrangler commands. The
account ID selects infrastructure ownership; it is not a user credential.

Deployment authorization and application sign-in are separate. Configure
[authentication and access](authentication.md) before using the gallery or MCP
on a network deployment. That guide covers provider credentials, database
migrations, admission rules, library permissions, and troubleshooting.

### Better Auth mode

Set `AUTH_MODE="better-auth"` to host provider sign-in in this deployment.
Configure the public origin, an identity provider, a deployment secret, an
admission rule, and an `AUTH_DB` D1 binding. Apply the checked-in migrations
before serving traffic. Follow the
[Better Auth setup](authentication.md#set-up-better-auth), including
[local development](authentication.md#local-better-auth-development).

### Cloudflare Access mode

The checked-in configuration defaults to `AUTH_MODE="access"`. Set up an Access
application and user policy, enable managed OAuth for MCP, and configure
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Follow the
[Cloudflare Access setup](authentication.md#set-up-cloudflare-access).

### Connect users and agents

Open the deployed hostname for the gallery. Add `https://<instance-hostname>/mcp`
to an OAuth-capable MCP client for a personal library, or append
`?library=team&workspace=<workspace>` for the shared team library. See
[connection instructions and supported credentials](authentication.md#connect-to-an-existing-deployment).
Before switching modes on an existing deployment, read
[the identity migration note](authentication.md#changing-authentication-modes-and-upgrading).

## Runtime limits

Artifacts runs as a Worker with SQLite Durable Objects and a Dynamic Worker
Loader. Runtime compilation requires Workers Paid. Compiles are serialized within
each isolate, with at most eight pending requests; production compliance with the
128 MiB memory limit has not yet been established.

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

## Upgrading source-only deployments

When upgrading a deployment that previously stored only source, explicitly
backfill the required revisions through its authenticated MCP endpoint before
reopening their links. List `artifact_history`, then call
`artifact_compile({version_id: "..."})` for each revision to retain as a runnable
view. `artifact_compile({name: "..."})` prepares a working draft. Already compiled
revisions reuse their pinned output. This does not edit source, rename links,
execute backends, or erase history. Invalid historical source remains readable
but cannot produce a runnable artifact until corrected. A missing artifact gives
an actionable compile diagnostic; a read never starts an implicit build.

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

## Native artifact servers and storage

See [App backends and SQLite](app-backends.md) for server source, secrets,
`artifactFetch`, and persistent data.

### Application schema migrations

See [application schema migrations](app-backends.md#application-schema-migrations).

### Server capabilities

See [server capabilities](app-backends.md#server-capabilities).

## Optional celld compatibility

[celld](https://github.com/denoland/celld) is a Cloudflare-compatible runtime.
Wrangler/workerd remains the default Cloudflare development path. Artifact also
targets the pinned celld v0.6.1 with integration tests for the built application, including
generated `ArtifactServer` execution on raw SQL and KV facets.
The generated config preserves the `worker_loaders` binding used by celld 0.6.1;
the removed `CELLD_WORKER_LOADER` environment variable must no longer be set.
The generated config sets `ARTIFACTS_RUNTIME=celld`, which omits the unsupported
script CPU and subrequest limits. celld does not enforce these per-script budgets.
Cloudflare retains the 30,000 ms CPU and 50 subrequest limits by default; do not
set this variable to `celld` on Cloudflare. See the [upstream compatibility notes](https://github.com/denoland/celld/blob/v0.6.1/docs/cloudflare-compat.md#dynamic-workers).

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
The worker-bundler patch in this checkout statically imports esbuild's WASM
module and initializes its browser global before bundler startup.
Passing the compatibility test does not add D1, R2 or other outer-Worker
bindings to generated artifact servers: their supported state remains the raw
Durable Object SQL/KV facets described in [app backends](app-backends.md).

When `AUTH_DB` is present in `wrangler.jsonc`, the generated celld configuration
carries that D1 binding. The auth integration fixture exercises the checked-in
Better Auth schema in local D1. The `celld d1 migrations apply` command
targets deployed bucket storage rather than the local development database, so
the Artifacts celld integration uses a temporary bootstrap Worker for local schema
setup. This fixture exercises the complete OAuth/session flow on celld v0.6.1;
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
