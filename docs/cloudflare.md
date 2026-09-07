# Cloudflare deployment and local development

Canvas can run as an ordinary Worker with SQLite Durable Objects and static
assets. Generated React executes in the browser sandbox. The server uses
`@cloudflare/worker-bundler` 0.2.3 and the same TypeScript 5.9.3 diagnostics as
the local Bun adapter; it does not use Dynamic Workers or install bun packages
while handling requests.

This runtime is experimental. Local workerd integration is tested, including
real MCP clients and Chromium, but production CPU/memory qualification is still
outstanding. Use Workers Paid: runtime compilation is unsuitable for the Free
plan's CPU budget. The current full Worker dry-run is approximately 25.4 MiB
uncompressed / 5.8 MiB gzip. Compiles are serialized within each isolate, with
at most eight pending requests. This reduces peak memory, but is not proof of
compliance with production's 128 MiB limit.

## Local workerd stack

```sh
bun install --frozen-lockfile
bun run dev:cloudflare
```

Wrangler runs workerd, local SQLite Durable Objects, and the real gallery assets
on `http://127.0.0.1:4785`. State persists under `.wrangler/state`. The explicit
local flag bypasses Access only for loopback hosts; production configuration
never enables that bypass.

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
flow provisions the Worker, assets and SQLite Durable Object migration. Configure
Access separately before using the gallery or MCP server:

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

Without these variables the application returns 503. With them, every protected
request must have an RS256 Access assertion with the matching issuer and audience.
Managed OAuth validates the MCP client's token at the edge and forwards the
signed assertion. Raw identity headers and unsigned JWT payloads are not trusted.
`/health` is a public runtime check and exposes no library data.

Open the deployed hostname for the gallery. Configure the centralized MCP server
URL as `https://<instance-hostname>/mcp?workspace=<workspace>` for a private library,
or `https://<instance-hostname>/mcp?library=team&workspace=<workspace>` for the team
library. You can register both endpoints in a client. The gallery has a **My
library / Team library** selector. Private is the default and is isolated by the
verified Access user identity; passing a different user ID cannot select another
person's data. All users authorized by this instance's Access policy can read and
edit the team library. Workspace names organize content inside a library and do
not grant access. Each deployment represents one team; deploy separate instances
with separate Access policies for unrelated teams. Infrastructure account
administrators can still administer the underlying storage.

Hosted MCP supports inline Canvas views, raw-source reads/writes/guarded edits,
semantic diagnostics, history, archived views and restore. It rejects the local
`herdr` pane target. Preview interactions remain local to their view. Raw source
and initial-state snapshots are persisted; compiled JavaScript is regenerated.
Sources are limited to 256 KiB, serialized state to 64 KiB, and MCP requests to
1 MiB. Large or particularly complex TypeScript can still exceed runtime budgets.

## Optional celld compatibility

[celld](https://github.com/denoland/celld) is a Cloudflare-compatible runtime.
Wrangler/workerd is the tested default here. A release v0.4.1 compiler probe
succeeded with worker-bundler 0.2.3 after two packaging adjustments: statically
import esbuild's WASM module and provide `globalThis.self = globalThis` before
bundler initialization. The unmodified dependency uses a dynamic WASM import
that celld rejects. Those shims are not applied to this project's dependencies,
so `celld dev` is not yet a supported zero-configuration alternative.

## Platform references

- [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
- [Access managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Hosted list/history results contain at most 100 entries and a `next_offset`.
Pass that value as `offset` to continue. `canvas_version` returns at most 20
serve events and `next_events_offset`; pass it as `events_offset` to retrieve
older events. A null continuation means the end. Gallery pages are loaded
sequentially. Pagination bounds individual Worker responses without deleting
history; concurrent writes may shift offset-based pages, so refresh if needed.
