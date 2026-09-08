# Runner status for Artifact

A private, read-only dashboard for a shared self-hosted GitHub Actions runner pool. Adapted from [microapps runner-status](https://github.com/nicosuave/microapps/tree/cfac26506848a11f21a7bb465a5a26acb5047af9/apps/runner-status). It preserves runner assignments, current steps, durations, repository/text filters, expandable steps, queued jobs, and partial-data behavior. Runner detail pages have bookmarkable paths such as `/runner-status/runners/123`.

This is a self-contained opt-in example, not part of the default Artifact installation. It has three pieces:

- `worker.ts` and `collector.ts`: one SQLite-backed Durable Object, shared polling and persisted last-known data; bundled with Artifact locally, or deployed separately on Cloudflare.
- `plugin.ts`: the `github-runners` deployment plugin, exposing `getStatus` to authenticated artifacts and MCP clients.
- `runner-status.artifact.tsx`: the single-file React artifact. It reads the same plugin snapshot as an agent.

The collector holds the GitHub token. The Artifact app Worker holds only the collector URL and a separate collector access token. Browser code receives neither token. The plugin uses an explicit `(subject, authority)` allowlist; its checked-in configuration denies everyone until configured. Artifact backends cannot call plugin functions, so the collector is an application-owned Durable Object rather than an artifact backend.

## Run the self-contained example on celld

From the Artifact repository root:

```sh
bun install --frozen-lockfile
# Supply GITHUB_TOKEN in your environment, or sign in once with gh auth login.
RUNNER_ORG=your-org RUNNER_REPOS=your-org/api,your-org/web bun run example:runner-status
```

Open the URL printed by the launcher (default `http://127.0.0.1:4786/runner-status`). It downloads and verifies the pinned celld executable if necessary, builds the example, starts **one native celld process containing both Artifact and its collector**, and creates the private artifact. No existing microapp, specific computer, Tailscale service, or Cloudflare deployment is required. GitHub is the only external data service. Bun and the repository dependencies are needed for building; GitHub CLI is optional when supplying `GITHUB_TOKEN`. Managed celld supports macOS arm64 and glibc Linux arm64/x64.

The organization and comma-separated repository list are required. Optional settings are `RUNNER_NAME_PREFIX`, `RUNNER_PORT` (default 4786), and `RUNNER_STATE_DIR` (default `.celld/runner-status` relative to the repository). The same state directory preserves the library, edits, history and collector cache across restarts. Use a distinct directory and port for each independent instance. Ctrl-C stops the runtime and its polling. No background/login service is installed.

The launcher reads `GITHUB_TOKEN` or `GH_TOKEN`, falling back to the normal `gh auth token --hostname github.com` command. The credential needs the GitHub permissions below. It generates a separate collector bearer token; neither token reaches the browser. Runtime configuration containing credentials is stored in the ignored state directory with owner-only directory/file permissions. Keep custom state directories private and out of version control.

The local plugin permits only `{ subject: "local", authority: "local" }` and calls the bundled collector over authenticated loopback HTTP. The entire runtime binds to `127.0.0.1`. The singleton collector starts on the first authorized status request and polls every 45 seconds even when the browser closes, until celld stops. Tabs share its persisted snapshot. Connect an MCP client to `http://127.0.0.1:4786/mcp` to edit the artifact or invoke the same read-only plugin.

The following sections describe the optional Cloudflare deployment of the same collector and artifact.

## Deploy the collector

Run from the Artifact repository root after `bun install --frozen-lockfile`. Edit `examples/runner-status/wrangler.jsonc` with your organization, repository list and optional runner-name prefix. Set a unique Worker name if necessary.

The GitHub credential must be able to read organization runners and Actions in every configured repository. For a fine-grained token, select **Self-hosted runners: read** at organization level and **Actions: read** for those repositories. Organization policy may require approval. See GitHub's [runner permissions](https://docs.github.com/en/rest/actions/self-hosted-runners#list-self-hosted-runners-for-an-organization) and [workflow job permissions](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run).

Use the secret prompts below; do not put credentials in source or shell arguments. Create a separate random collector access token in your password manager and provide the same value to both Workers.

```sh
bun x wrangler secret put GITHUB_TOKEN --config examples/runner-status/wrangler.jsonc
bun x wrangler secret put RUNNER_STATUS_TOKEN --config examples/runner-status/wrangler.jsonc
bun x wrangler deploy --config examples/runner-status/wrangler.jsonc
```

Record the resulting `https://<collector-host>/api/status` URL. This endpoint requires `Authorization: Bearer <collector access token>` and accepts only GET. It serves data to the Artifact plugin, not directly to browsers.

## Install the Artifact plugin

Edit `examples/runner-status/artifacts.plugins.ts`, replacing `allowedUsers: []` with the exact Artifacts identities allowed to inspect the pool:

```ts
allowedUsers: [
  { subject: "YOUR_ARTIFACTS_USER_ID", authority: "better-auth" },
]
```

For Better Auth, the user ID comes from `/api/session` while signed in; `authority` is `better-auth`. For Cloudflare Access, use the verified identity's JWT `sub` and issuer (`https://<team>.cloudflareaccess.com`). Do not substitute an email address for the subject. Everyone on this allowlist sees the same configured pool, independently of which artifact or library invokes the plugin.

If you already have a plugin config, add `runnerStatusPlugin(...)` to it and retain the existing entries. Otherwise use this example config for **both** Worker builds/deployments:

```sh
# These target the main Artifact app Worker using the root Wrangler configuration.
bun x wrangler secret put RUNNER_STATUS_URL
bun x wrangler secret put RUNNER_STATUS_TOKEN

ARTIFACTS_PLUGINS_CONFIG=examples/runner-status/artifacts.plugins.ts bun run build:cloudflare-compiler
ARTIFACTS_PLUGINS_CONFIG=examples/runner-status/artifacts.plugins.ts bun run build:cloudflare
```

Set `RUNNER_STATUS_URL` to the collector's exact HTTPS `/api/status` URL and `RUNNER_STATUS_TOKEN` to the collector access token. Then deploy the Artifact compiler and app using your existing deployment configuration and the same `ARTIFACTS_PLUGINS_CONFIG` value; see [Cloudflare deployment](../../docs/cloudflare.md). The GitHub credential belongs only on the collector.

## Create the artifact

Connect an MCP client to the authenticated **hosted** Artifacts deployment. Call `artifact_guide`, then `artifact_write` with `name: "runner-status"` and the contents of `runner-status.artifact.tsx` as `contents`. This example has no artifacts server source. In the gallery, select the artifact, set its URL slug to `runner-status`, keep access **Private**, and save the link.

The standalone URL supports `/runner-status/runners`, `/runner-status/running`, `/runner-status/queued` and `/runner-status/runners/<id>`, including reload and browser history. Gallery and MCP views use the runtime's independent in-frame history. Public standalone links and plain local CLI/gallery views cannot invoke authenticated plugin functions.

Agents can discover the plugin through `plugins_list` and call:

```json
{
  "plugin": "github-runners",
  "operation": "getStatus",
  "input": {}
}
```

Pass that object to `artifact_plugin_call`. The result includes runner/job data, per-repository freshness, runner freshness, refresh time and errors. There are no write, cancel or rerun operations.

## Refresh and interpretation

The first authorized request starts the collector. One [Durable Object alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) refreshes the pool every 45 seconds thereafter, even with no open browser. Tabs request the cached snapshot every 15 seconds; Refresh reads that cache and triggers a background refresh only when due. A restart reloads the persisted snapshot and alarm. Changing the configured organization, repositories or prefix invalidates the prior cache.

Each refresh uses at most four simultaneous GitHub requests across all repositories and pagination, with a 25-second overall deadline. A refresh costs approximately `1 + 5 × repositories + active workflow runs` requests, plus pagination. A failed source retains its last successful data and timestamp. The response reports the failure without exposing provider error bodies. Stop/delete the collector deployment when you no longer want background polling.

- Discovery covers only the configured repositories. A busy runner whose assignment cannot be found stays busy with an unknown assignment.
- Label matches do not account for every GitHub scheduling constraint. Empty labels mean unknown eligibility.
- Queued duration means time since workflow creation, not time executing, time actually spent queued, or guaranteed queue position. Waiting jobs may require approval or a workflow condition.
- The sample supports up to 20 configured repositories and 100 pages per endpoint. It bounds returned snapshots below the plugin bridge's 256 KiB limit and explicitly reports omitted rows. Narrow the repository list or runner prefix if it reaches that limit.
- Expired/revoked GitHub credentials appear as partial data until replaced. Automatic provider OAuth/token renewal is outside this sample.

## Checks

No credentials, deployment or live GitHub access are needed:

```sh
bun run typecheck
bun test examples/runner-status --timeout 60000
bun test e2e/runner-status.test.ts --timeout 30000
bun x wrangler deploy --dry-run --config examples/runner-status/wrangler.jsonc --outdir /tmp/artifact-runner-status-build
```

The unit tests cover pagination, global concurrency, run deduplication, label matching, authorization, bounds and stale-data recovery. The workerd test verifies shared requests, cache persistence and alarm-driven polling after restart (about 45 seconds). Browser tests compile the real artifact and use synthetic snapshots to exercise navigation, filtering, steps, empty/error states and stale-data handling. These checks run through the normal repository test commands as well.
