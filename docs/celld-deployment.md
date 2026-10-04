# Deploying Artifacts with celld

Use celld to run Artifacts on infrastructure you manage. For a single-machine
local installation, start with the [host guide](daemon.md) or [Docker guide](docker.md).
This page covers operating a deployment backed by object storage, including
multiple nodes, TLS, persistence, and upgrades.

Connect your existing sign-in service, such as Google, Okta, or a self-hosted
Keycloak server. Artifacts includes **Better Auth**, the authentication library
that connects to these and other OAuth/OIDC providers. If you place the deployment
behind Cloudflare Access, that can handle sign-in instead.

The bundled runtime is pinned to celld 0.6.1. This guidance follows the
[upstream deployment documentation](https://github.com/denoland/celld/blob/v0.6.1/docs/README.md)
and [security model](https://github.com/denoland/celld/blob/v0.6.1/docs/security.md).

For provider setup, MCP sign-in, database requirements, and library permissions,
start with [authentication and access](authentication.md#configure-celld).

## Local persistent host

`artifacts host` (also available as `artifacts server`) runs the packaged app
through `celld dev --no-watch`, on loopback with local state. It supports macOS
arm64 and glibc Linux arm64/x64. Background management uses launchd or systemd
user services. No network provider is required. See [host commands](daemon.md).

This mode keeps state on one machine. Keep its project path and `.celld/dev`
data stable across upgrades. Local persistence does not provide
a replicated fleet or protect against losing the machine. A consistent offline
copy requires stopping the service; copying live SQLite files is not a backup
procedure. Preserve the runtime configuration alongside state; configuration
can contain credentials.

## Deployed celld nodes

For production or multiple machines, use celld's bucket-backed node mode:

1. Choose a supported object store with conditional writes and consistent reads.
   Upstream qualifies Amazon S3, Cloudflare R2, Google Cloud Storage, Tigris, and
   Azure Blob Storage. Not every S3-compatible provider meets the requirements;
   consult the [storage guarantees](https://github.com/denoland/celld/blob/v0.6.1/docs/guarantees.md).
2. Prepare the Artifacts Worker with `bun run build:package`, configure application
   [authentication](authentication.md#configure-celld) and runtime variables, and
   deploy the prepared Wrangler project
   through `celld deploy`. Preserve JavaScript and WASM modules together. Do not
   carry the local template's `ENVIRONMENT=local` authentication bypass into a
   publicly accessible deployment.
3. Run a normal celld node against that bucket under systemd, a container
   orchestrator, or another supervisor. The core host command currently manages
   the local mode; it does not provision a bucket or launch a production fleet.
4. Terminate TLS and authenticate users in the application or a chosen reverse
   proxy. Keep the operator/peer listener on a trusted private network, with an
   encrypted overlay when that network does not provide confidentiality.
5. Use `/.well-known/celld/health` for node readiness. `/health` is an application
   route and does not establish node readiness. Allow graceful SIGTERM shutdown:
   the supervisor's stop grace must exceed celld's configured shutdown bound
   (40 seconds by default), with enough time for the expected drain and handoff.
6. Update app code through `celld deploy`. Running nodes adopt deployments in
   place; a failed build leaves the previous deployment serving. For runtime
   upgrades, follow the release-specific shutdown requirements. The
   [0.6.0 release](https://github.com/denoland/celld/releases/tag/v0.6.0) requires
   stopping the whole fleet when upgrading from 0.5.1 with fleet durability;
   bucket durability supports a rolling update. The
   [0.6.1 release](https://github.com/denoland/celld/releases/tag/v0.6.1) supports
   a rolling update from 0.6.0. For older installations, check intervening releases.

Two or more nodes reduce write latency through peer durability; a single node
waits for bucket persistence. Monitor memory headroom, cold activation queues,
and disk space. Reserve capacity for startup and deploys. The local dev supervisor
has an internal 30-second listener-announcement deadline; increasing an outer service
timeout does not change it.

Moving an existing local `.celld/dev` installation to a bucket-backed fleet is a
separate data migration. Changing startup flags does not migrate its saved state.
