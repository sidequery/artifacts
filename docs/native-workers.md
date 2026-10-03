# Native Worker apps

Native apps deploy ordinary Cloudflare Worker modules with their default handler and named Durable Object exports. They use native KV, R2, D1, queue and DO bindings rather than the script SDK's `env.sql` wrapper. The gallery's **Worker apps** button and hosted MCP `app_*` tools use the same authenticated deployment controller.

An app belongs to a private or team library and a workspace. Its UUID permanently owns provider resources; source revisions, export names, logical library moves and binding names do not change those identities. App URLs are private:

```text
/apps/my-app/?workspace=default&library=private
```

The controller authenticates library access before proxying HTTP, removes management credentials/cookies and strips response cookies. The app receives its app-relative path and deployment origin. HTTP bodies stream and have no browser/MCP envelope limit. App URLs must include their workspace/library selectors on subsequent requests; clients should preserve these selectors when constructing links. This delivery does not assign public root slugs or provide an iframe application viewer.

## Manifest and source

Use `app_guide` before authoring. `app_write` takes `name`, `source`, `manifest`, an optional provider, and the same helper/dependency `project` used by scripts. Source is the main module's contents; `manifest.main` gives its relative path for resolving imports. Helper files and exact dependency bytes are saved with the immutable revision. The compiler preserves the default and named exports, adding stable generated aliases for DO identities.

```json
{
  "main": "worker.ts",
  "compatibility_date": "2026-09-06",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "GREETING": "Hello" },
  "secrets": ["API_TOKEN"],
  "bindings": {
    "COUNTERS": { "type": "durable-object", "resource": "counters", "class_name": "Counter" },
    "CACHE": { "type": "kv", "resource": "cache" },
    "FILES": { "type": "r2", "resource": "files" },
    "DB": { "type": "d1", "resource": "database" },
    "JOBS": { "type": "queue", "resource": "jobs" }
  },
  "triggers": { "crons": ["*/5 * * * *"], "queues": ["jobs"] }
}
```

Unknown manifest fields fail closed. Bindings cannot refer to external namespaces, services, accounts or databases. Resource names cannot change type, and each resource appears once. There are at most 32 bindings, 32 variables, 32 secret names and 32 cron triggers. Standard five-field cron uses the provider's native UTC scheduling. Queue handlers receive native batches and can use native retry/ack APIs.

Call `app_secrets` to set the declared secret values. Secret updates are atomic, list only names, and redeploy the current desired revision. Only declared app secrets enter native `env`; controller/provider credentials remain outside authored modules. Revisions and `app_read` never include supplied secret values. Secrets can also be set on the draft created by a first write that reports a missing secret.

`app_read` returns a `revision_token` for conditional source saves. Pass it as `expected_revision`; a stale source/manifest/helper/dependency snapshot produces a conflict. `null` requires a new app name. Invalid compilation retains the saved draft while leaving the last deployed version active. Deployment failures return `ok:false`, stage/error and both desired/active revision IDs; HTTP access stays unavailable until provider state has been reconciled.

## Providers

Deploy the controller's `NativeApps` SQLite DO binding/migration from the updated Wrangler configuration. Provider configuration is operator-owned and optional. Existing artifact/script behavior remains available without configuring a native provider.

### Cloudflare

Set `NATIVE_CF_ACCOUNT_ID` as a controller variable and `NATIVE_CF_API_TOKEN` as a controller secret. Use a dedicated account or reserve the `art-app-*` Worker and `art-*` resource name prefixes exclusively for the controller. The token needs Worker script/service/subdomain/domain/schedule management, KV namespace management, R2 bucket management, D1 database management and Queue/consumer management for that account, plus zone and Worker-route read access for every zone in that account. No routing-write permission is needed. Missing permission fails deployment instead of weakening ingress verification.

The provider creates deterministic app-owned resources and uploads the native Worker via the [Worker module API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/). DO migrations create SQLite namespaces under permanent aliases; removed namespaces remain exported as dormant stubs and are never deleted. A class rename reuses its original alias. New bindings can be added without replacing existing resources. Queue attachments and cron settings reconcile independently of code publication.

Auth is enforced in a separate trusted gateway Worker with a service binding to the native app. The gateway credential belongs only to the controller and gateway. The native app receives no gateway or Cloudflare token. The provider first creates a deny-only Worker, disables both `workers.dev` and preview URLs, verifies the absence of zone routes/custom domains, and only then uploads authored code. It rechecks ingress after publication. The gateway's protected readiness endpoint must report the desired revision before activation. Native app Workers must never be exposed by another route or custom domain; controller reconciliation rejects such routing changes. Gateway URLs are internal provider endpoints, not user links.

The gateway and host proxy retain native HTTP streaming and Cloudflare WebSocket upgrades. Cloudflare account configuration is fixed for an app; changing the account variable blocks reconciliation so an accidental configuration change cannot silently relocate data.

### celld-local

Set controller variables `NATIVE_CELLD_OPERATOR_URL` and `NATIVE_CELLD_TRUSTED_APPS=true`, and controller secret `NATIVE_CELLD_OPERATOR_TOKEN`. Start the separate [local operator](native-worker-operator.md) with the same credential. The URL must be HTTPS, or loopback HTTP when both services run on the same machine; include no path, query or embedded credentials. The operator's origin is fixed for an existing app. Moving to another machine requires an explicit storage-transfer operation outside this delivery.

This provider uses pinned celld 0.6.1 and accepts trusted applications only. celld does not offer hostile multitenant isolation. Each app uses one supervised loopback process and a stable persistent store. The operator stages changes, stops the old runtime, restarts against retained storage and checks celld runtime readiness without invoking the app handler. Updates can cause brief downtime. Failed startup reinstalls previous code/configuration while retaining current data. The operator rejects WebSocket upgrades with `501`.

## Recovery and restoration

The controller journals desired code, complete reserved resource identities, provider IDs and DO migration plans before external mutations. Each app has a serialized mutation stream. Resource creation reconciles deterministic names after ambiguous responses; it never blindly allocates a second resource or deletes storage as compensation. Automatic controller retries are bounded to three attempts; `app_reconcile` starts a fresh attempt against the same desired revision. An operator restart also reconciles its persisted desired app state.

`app_history` lists immutable compiled revisions. `app_restore` creates a deployment from archived source against the full current resource ledger and current secrets. Removed resources can be bound again under their original names, restoring access to retained data. Resource type changes require a new resource name. `app_move` changes logical library ownership while retaining the same physical app, source history, resources and secrets; the former owner loses subsequent management and HTTP admission. Reusing the vacated name allocates a fresh physical app.

Code restoration does not restore data or undo DO lifecycle migrations. There is no managed D1 SQL migration runner: schema changes belong to application code and must remain compatible with retained data and restored revisions. Queue/cron changes and Worker publication are not a single provider transaction; `recovery-required` explicitly means the observed deployment may be partial. Native event side effects can occur while publication is incomplete and are not replayed or rolled back by the controller. Queue handlers must tolerate retries.

Providers cannot change on an existing app. Destructive storage deletion, fleet bucket publication, cross-provider data transfer, app log collection, workflows and other undeclared bindings/events are outside this delivery.

## Validation

`bun test cloudflare/native-worker/cloudflare.test.ts` validates Cloudflare API payloads, ambiguous-creation recovery, ingress failure handling and the real workerd gateway boundary. `NATIVE_WORKER_CELLD=1 bun test cloudflare/native-worker.test.ts scripts/native-worker/operator.test.ts --timeout 180000` exercises authenticated management and native execution against disposable celld 0.6.1 storage. Cloudflare API tests use controlled API responses; they do not claim deployment to a live Cloudflare account.
