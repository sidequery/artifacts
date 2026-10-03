# Local native Worker operator

The `celld-local` provider runs each trusted app in its own persistent celld 0.6.1 process. The Artifacts controller owns app authorization, immutable app UUIDs, revisions, resource identities, and compilation. This operator owns local processes and their storage. It is a separate service from the gallery Worker.

celld 0.6.1 trusts application code and is not a hostile multitenant sandbox. Separate app directories and processes preserve independent resource identities; they do not isolate malicious code from the host network. Use this provider for the existing trusted, single-user host. Cross-provider data transfer is unsupported; an app's provider remains fixed.

## Run

From the repository with dependencies installed:

```sh
# Supply a random token of at least 32 characters through your service manager.
export NATIVE_WORKER_OPERATOR_TOKEN='replace-with-a-random-service-token'
bun run scripts/native-worker/operator.ts
```

The default listener is `127.0.0.1:4792`. Configure the Artifacts controller with this operator's base URL and the same token. An operator URL must be reachable from the controller; a Cloudflare-hosted controller cannot reach a private machine's loopback address directly. Use a TLS-protected private route when the controller runs elsewhere. Never put this token in an app manifest, browser, shared app link, or authored Worker environment.

| Variable | Purpose |
| --- | --- |
| `NATIVE_WORKER_OPERATOR_TOKEN` | Required bearer credential for every operator endpoint; at least 32 characters. |
| `NATIVE_WORKER_OPERATOR_ROOT` | Persistent data directory. Defaults to `native-workers` under the existing Artifacts data root. |
| `NATIVE_WORKER_OPERATOR_HOST` | Listener address; defaults to `127.0.0.1`. Bind a private interface only behind the intended network and TLS boundary. |
| `NATIVE_WORKER_OPERATOR_PORT` | Listener port; defaults to `4792`. |
| `CELLD_BIN` | Optional operator-managed celld 0.6.1 executable. Otherwise the existing checksum-verified runtime installer selects 0.6.1. |
| `CELLD_ESBUILD` | Optional esbuild executable. Defaults to the installed esbuild package resolved from the operator, including hoisted installations; a private Bun launcher avoids requiring Node on the child process PATH. |

Run one operator per data root under launchd or an equivalent service manager with automatic restart. Keep the data root on persistent local storage, owned by the operator account. Back up the entire root consistently while the operator is stopped. Do not delete `.celld/dev`, pass `--clean`, or copy an active store between processes.

An exclusive SQLite transaction on `operator-lock.sqlite` holds data-root ownership for the operator process lifetime. The operating system releases it even after a crash during startup; no separately published owner file is needed. Keep this lock file in place, including after shutdown, so all contenders use the same file. Empty `operator.lock` directories left by the earlier implementation do not block recovery. Stop an older operator before upgrading its lock implementation.

`SIGTERM` and `SIGINT` stop the operator and gracefully stop its app runtimes. An interrupted operator records enough process identity to stop a surviving celld supervisor before reopening its state on restart. A different process reusing a recorded PID is never signaled. A runtime that does not stop within the grace period blocks replacement instead of starting another writer.

## Controller protocol

All requests require `Authorization: Bearer <token>`. Token comparison uses fixed-length SHA-256 digests and a timing-safe comparison.

- `GET /health` reports operator readiness without calling app code.
- `POST /deploy` accepts the shared `NativeDeployment` contract: `app`, `revision`, `resources`, and `secrets`. The controller supplies compiled native code, stable generated Durable Object aliases, and retained stubs for removed classes. A successful response contains `{ revision, endpoint }`; the endpoint is the operator's `/apps/<uuid>/` proxy, never an app runtime port. Keep this response internal to the controller.
- `/apps/<uuid>/*` proxies authenticated HTTP requests to that app's loopback runtime. The controller supplies the original public request URL in `x-artifacts-target-url`; only HTTP(S) URLs without embedded credentials or fragments are accepted. A generated routing adapter restores that URL and removes the transport header before invoking the authored fetch handler. It preserves native named exports and default object/class scheduled and queue handlers. Operator authorization, cookies, Cloudflare Access credentials, app selection, gateway credentials, and forwarded routing headers are also removed before app code runs. Requests and responses stream, and redirects are returned to the controller without being followed by the operator.

The controller must authenticate each private app link and select the authorized app before it calls the operator. The service token proves that a request came from the controller; it is not an end-user authorization policy. App listeners remain loopback-only and must not be published by a separate reverse proxy that bypasses the controller.

The routing adapter is necessary because celld 0.6.1 `dev` disables forwarded-host/protocol trust for its child node. Sending only `Host` could preserve an authority but would still expose an `http:` origin for an HTTPS deployment. The adapter performs no authentication and receives no management credential; the operator authenticates before introducing the target URL. Direct operator requests without a target header use the operator request's origin and the app-relative path.

App UUIDs and revision/resource hashes are validated before filesystem operations. The manifest rejects undeclared configuration. Existing resource IDs and types cannot change or disappear from the retained ledger. Reusing a revision ID with different code, source, or manifest is rejected.

## Persistence and recovery

Each app has a private directory under `apps/<uuid>/`:

- `deployment.json` records the last active deployment, any desired deployment, and retained resource identities. It contains no supplied secret values.
- `revisions/` contains immutable source/manifest/code revisions without supplied secret values.
- `secrets/` contains only the active and pending app secret sets in private files. Obsolete sets are removed after successful reconciliation.
- `project/` is the stable celld project, including its retained `.celld/dev` storage. Its private generated configuration includes the app secrets required by celld. The local celld store can also retain deployment metadata; protect the entire data root as secret-bearing storage.
- `launch.json` and `runtime.pid` identify the runtime owned by this operator.

The operator writes and syncs the desired deployment before replacing code, configuration, or a runtime. Candidate files are staged first, the old runtime is stopped, and the candidate starts against the same store. Readiness uses celld's reserved `/.well-known/celld/health` route, so deployment does not invoke the authored fetch handler.

If startup fails, the operator reinstalls the previous active code and configuration and restarts it. The failed desired deployment remains recorded for reconciliation. Restarting the operator retries pending desired deployments, then restores the last active code if the pending candidate still fails. A repaired deployment can also be submitted explicitly through the controller. A broken app does not prevent the operator's repair API or other apps from starting.

Unexpected runtime exits trigger up to three restart attempts, with bounded increasing delays. A new explicit deployment resets that retry budget. After the budget is exhausted, requests receive `503`; use controller reconciliation or restart the operator after resolving the underlying failure.

This is a code/configuration rollback, not a data rollback. App writes, queue delivery, alarms, and any app-managed schema changes that occur before failure remain. Native queues can deliver more than once; handlers must tolerate retries. Updates can briefly interrupt requests while the one writer restarts.

## Supported surface and limits

Native Durable Object HTTP/RPC and SQLite storage, KV, R2, D1, queue producers/consumers, and cron configuration use celld's native bindings. The generated physical Durable Object alias depends on the retained resource ID, preserving data when the authored export or binding changes. Removed resources remain reserved for restoration.

There is no operator-managed D1 SQL migration runner in this delivery. celld's rejected class rename/delete/transfer migration forms are not emulated. App-managed schema changes must be compatible with the current persisted data and any code restoration.

WebSocket upgrade proxying is not implemented by this operator; upgrade requests receive an explicit `501`. Ordinary HTTP bodies stream. Deployment request bodies are limited to 16 MiB, including source and compiled code. No app or process logs are exposed through the operator API; runtime output is consumed without persisting it because authored output can include secrets.

This operator does not implement a celld fleet bucket deployment API. Fleet support requires a distinct operator contract and recovery handling for its deployment pointers and queue attachments.

## Verify

```sh
bunx tsc -p scripts/native-worker/tsconfig.json --noEmit
bun test scripts/native-worker/operator.test.ts
NATIVE_WORKER_CELLD=1 bun test scripts/native-worker/operator.test.ts --timeout 180000
```

Set `CELLD_BIN` for a previously verified 0.6.1 executable when running integration tests. Integration coverage exercises native storage and queue delivery, authentication and credential stripping, class rename retention, updates, failed startup restoration, operator restart, startup-crash lock release and live-owner exclusion, and abrupt operator-process crash recovery.
