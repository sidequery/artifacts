# Native Worker app prototype

The prototype runs an ordinary Worker project with its default handler, named
Durable Object classes and native bindings. The fixture at
[`examples/native-worker/worker.ts`](../examples/native-worker/worker.ts) has no
Artifacts SDK imports, export renaming or host wrapper. Its sidecar
[`app.json`](../examples/native-worker/app.json) declares what the app owns.

Run from the checkout:

```sh
NATIVE_WORKER_SECRET_API_TOKEN=example \
  bun run scripts/native-worker/host.ts examples/native-worker/app.json local example
```

The controller prints the loopback URL. Request `/`, `/rpc`, `/queue`, `/events`
or `/storage`. Ctrl-C stops it. Repeating the command with the same physical owner
and app identity reuses `.artifacts/native-workers` storage. Only declared secrets
are read from `NATIVE_WORKER_SECRET_<NAME>`; the Worker's environment contains only
declared variables, secrets and app resources.

## What is implemented

| Contract | Prototype behavior |
| --- | --- |
| Entrypoints | Normal Worker bundling preserves default and named exports; HTTP and DO RPC use native workerd APIs |
| Manifest | Relative JS/TS entrypoint, compatibility date/flags, string vars, secret names, native DO/KV/R2/D1/queue bindings, cron and queue triggers |
| Ownership | Resource IDs hash the immutable physical owner/app identity and stable `resource` name; callers cannot supply another namespace ID or host service binding |
| Provisioning | The development provider creates native resources through Miniflare; each app has a separate storage root and namespace IDs |
| Revision updates | Source and manifest changes keep resource IDs; DO class renames use the same namespace identity |
| Removal/restoration | Removing a binding revokes it from the new environment but retains storage and the resource reservation; restoration uses existing data and explicitly supplied current secrets |
| Invalid updates | Unknown manifest fields, undeclared bindings/secrets and resource type reuse fail; invalid module updates reinstall the last accepted configuration |
| Events | Declared cron events can be invoked through `host.scheduled()`; producers deliver to the native queue consumer handler with ack/retry support supplied by the runtime |
| Secrets | Values remain in runtime configuration memory; saved source/manifest revisions contain secret names, never supplied secret values |

The manifest's `resource` is distinct from the binding name and DO export name.
Renaming an export while keeping `resource: "counters"` preserves the namespace.
Changing a resource's type is rejected, including after removal. Schema migrations
inside a DO/D1 database remain authored application code; restoring source does
not roll back database contents or schema changes.

## Runtime evidence

```sh
bun run test:native-worker
NATIVE_WORKER_CELLD=1 bun test scripts/native-worker/celld.test.ts --timeout 180000
```

The native smoke test uses the managed celld **0.6.1** executable, or `CELLD_BIN`
when explicitly supplied. It runs the same bundled fixture under an ordinary
Wrangler deployment and tests DO HTTP/RPC, KV, R2, D1 and producer-to-consumer queue
delivery. The workerd controller tests additionally cover cron invocation,
streaming HTTP, app/secret isolation, resource preservation across class renames,
binding removal, source restoration, process restart and rejected updates.

## Relationship to managed native apps

This standalone proof still uses Miniflare as its development provider. The
separate [managed native app implementation](native-workers.md) now supplies
authenticated ownership, immutable revisions, isolated secrets, Cloudflare
provider reconciliation, a celld-local operator, and gallery/MCP management.
Use that path for managed deployment; the CLI in this document remains a
development proof with caller-supplied identities.

The original production checklist below describes the concerns that motivated
the managed controller. Its supported boundaries and remaining limitations,
including trusted local execution and application-owned D1 schema changes, are
documented in the managed native app guide.

1. Add a Worker app project kind and immutable source/manifest revisions to the
   existing library, ownership, link and compilation paths. Bind the physical
   identity to authenticated ownership rather than CLI arguments.
2. Add deployment providers: translate the resource ledger into celld deployments
   or Cloudflare provisioning/upload APIs. Persist provider handles and migration
   progress, and recover partial deployment/provisioning failures. The prototype's
   local serialized controller is not a distributed transaction.
3. Define migration rules for additions, DO renames, removals and ownership moves.
   Preserve removed storage until explicit deletion; validate database downgrade
   compatibility before restoring an older source revision.
4. Persist current secrets separately from version exports, register cron triggers,
   and coordinate queue consumers with the active deployment. Specify delivery,
   retry, dead-letter and pause behavior during upgrades.
5. Apply production resource budgets, authenticated management, URL policy and
   network isolation. Loopback development URLs and unrestricted development
   outbound access are not a multi-tenant security boundary. One controller must
   own each physical app; this prototype has no cross-process deployment lock.

The alternative is to keep app code under `WorkerLoader`. That requires custom
bindings which reproduce each native resource API the app uses. Cloudflare's
[Dynamic Worker binding contract](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)
requires wrapping normal platform bindings, while
[facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
provide persistent child DO instances. A facet namespace adapter would need
native identity/get/stub/RPC/alarm/WebSocket semantics; a KV/R2/D1 wrapper would
need their full result, stream and transaction contracts. The prototype establishes
a working native deployment path without claiming that these adapters already exist.
