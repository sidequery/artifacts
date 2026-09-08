# Deploying Artifacts with celld

The bundled runtime is pinned to celld 0.4.1. This guidance follows the
[upstream deployment documentation](https://github.com/denoland/celld/blob/v0.4.1/docs/README.md)
and [security model](https://github.com/denoland/celld/blob/v0.4.1/docs/security.md).

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
   consult the [storage guarantees](https://github.com/denoland/celld/blob/v0.4.1/docs/guarantees.md).
2. Prepare the Artifacts Worker with `bun run build:package`, configure application
   authentication and runtime variables, and deploy the prepared Wrangler project
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
   place; a failed build leaves the previous deployment serving. Roll runtime
   upgrades with readiness checks and spare capacity rather than restarting every
   node together.

Two or more nodes reduce write latency through peer durability; a single node
waits for bucket persistence. Monitor memory headroom, cold activation queues,
and disk space. Reserve capacity for startup and deploys. The local dev supervisor
has an internal 30-second listener-announcement deadline; increasing an outer service
timeout does not change it.

Moving an existing local `.celld/dev` installation to a bucket-backed fleet is a
separate data migration. Changing startup flags does not migrate its saved state.
