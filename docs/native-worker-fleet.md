# Native Worker apps on a celld fleet

The `celld-fleet` provider runs native apps on the same bucket-backed fleet as
Artifacts. Use pinned celld 0.6.1 and one authenticated publisher. The publisher
has no local app databases: native storage and the deployment registry remain
in the fleet bucket, and the `NativeApps` controller retains source, secrets,
resource identities and desired deployment state.

## Deployment

Build the Docker `fleet-operator` target alongside the ordinary `runtime`
target. CI publishes `ghcr.io/sidequery/artifacts:fleet-sha-<commit>` and
`ghcr.io/sidequery/artifacts:sha-<commit>` for the same source commit.

Start the publisher with these environment variables:

| Variable | Purpose |
| --- | --- |
| `CELLD_BUCKET` | Existing S3 fleet bucket, including its prefix when used. |
| `AWS_REGION` | Bucket region; normal AWS credentials or workload identity apply. |
| `NATIVE_CELLD_FLEET_OPERATOR_TOKEN` | Private service credential, at least 32 characters. |
| `NATIVE_CELLD_FLEET_CONFIG` | Prepared Artifacts Wrangler configuration; default `/app/wrangler.jsonc`. |
| `NATIVE_CELLD_FLEET_NODE_SERVICE` | Headless DNS name returning all node IPs. |
| `NATIVE_CELLD_FLEET_NODE_PORT` | Public Worker port for adoption checks; default `4786`. |
| `NATIVE_CELLD_FLEET_NODES` | Alternative: comma-separated node URLs for adoption checks. |
| `NATIVE_CELLD_FLEET_HOST` | Listener interface; default loopback. |
| `NATIVE_CELLD_FLEET_PORT` | Listener port; default `4792`. |
| `NATIVE_CELLD_FLEET_BASE_PATH` | Optional HTTP path prefix. |

Controller vars must include `NATIVE_CELLD_TRUSTED_APPS=true`, the same private
token in `NATIVE_CELLD_FLEET_OPERATOR_TOKEN`, and its URL in
`NATIVE_CELLD_FLEET_OPERATOR_URL`. Use HTTPS or loopback HTTP. Declare native
apps only for admitted, trusted users; the runtime's isolation contract is
unchanged by this provider.

Run one publisher replica with a Recreate rollout. It serializes both app
updates and host releases. A release hook sends authenticated `POST /host`
through that service using the publisher image's `--request-host` command and
`NATIVE_CELLD_FLEET_RELEASE_URL`. The hook runs after the publisher becomes
ready and before celld nodes start. Host publication does not wait for nodes,
so a fresh empty bucket can bootstrap. App publication verifies adoption on
every discovered node before reporting activation.

All publisher HTTP requests require its bearer token. `GET /health` reports
publisher readiness; `POST /deploy` accepts the existing `NativeDeployment`
contract. Management credentials and root host configuration never enter an
authored app's environment.

## Publication and recovery

celld 0.6.1 has one fleet-wide default pointer. The publisher runs candidate
`celld deploy` commands in separate staging prefixes, copies their immutable
modules and manifests, then publishes the named app pointers and native queue
attachments. It adds private service bindings to the host, preserves Artifacts
as the default, and conditionally commits the host pointer. Its deployment
registry is part of that host manifest, so later host releases preserve apps.
An intervening default-pointer change fails publication instead of overwriting
another release. Do not publish directly into this fleet with plain `celld
deploy`; all changes must use the coordinated publisher.

The controller persists desired revisions before calling the publisher.
Interrupted or failed publication remains `recovery-required`; use
`app_reconcile` to resume the same revision and retained resources. Source
restoration retains current data and current app secrets. Source revisions do
not roll back databases, files, queue delivery or application schema changes.
Native queue attachment and code publication can be partial until recovery
finishes; event handlers must tolerate retries.

The host owns the union of app cron expressions because celld 0.6.1 does not
automatically fire a cohosted Worker's cron. It invokes generated scheduler
entrypoints in each app's native environment and waits for `waitUntil` work.
The controller remembers successful/no-retry occurrences, so another app's
retry does not rerun already completed cron handlers. Interrupted occurrences
retain the normal possibility of repeated side effects.

HTTP and WebSocket responses use native service bindings. Public upgrades
still require an ingress that supports WebSockets. The gallery uses an HTTP
event stream for its live updates, including behind HTTP-only load balancers.

## Validation

`NATIVE_WORKER_FLEET=1 bun test scripts/native-worker/fleet.test.ts --timeout
240000` uses a disposable S3-compatible fixture and two pinned celld nodes.
It verifies native storage, queues and cron delivery, private/team isolation,
credential stripping, invalid drafts, source/host updates, and node/publisher
restart. Configure `FLEET_TEST_S3_ENDPOINT` for the fixture. These tests do not
write to the production bucket.
