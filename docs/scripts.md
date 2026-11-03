# Endpoints, direct links and legacy scripts

Use an endpoint for an API, webhook, or scheduled job. An endpoint is an
artifact without a UI: a TypeScript HTTP handler with its own SQLite database,
secrets, logs and run history. It runs in the full Artifacts application,
including `artifacts host` on your machine. Artifacts with a UI use the same
server contract under `/api`; see [app backends](app-backends.md).

Create one in the gallery with **New endpoint**, or ask your coding agent to
read `artifact_guide` with topic `backend` and call `artifact_write` with
`server` and no `contents`. Give it a URL such as `/stripe-webhook`, then choose
whether it is private or public. Saving valid source makes it live immediately.
Requests to the URL run its handler; selecting it in the gallery only opens its
editor.

- [Create and run an endpoint](#gallery)
- [Write a handler and store data](#server-handler)
- [Control who can call it](#access)
- [Add packages and helper files](#third-party-dependencies)
- [Schedule a run](#schedules-and-execution-history)
- [Copy or move an item](#remix)
- [Scripts created before endpoints](#legacy-scripts)

Artifacts with a UI can also have direct URLs, such as `/sales-dashboard`, which
open their React interface and backend. Native Workers can have them too. URL
slugs are unique across the deployment, including across item types and
libraries; existing application routes are reserved.

## Gallery

Choose **New endpoint**, enter a name and URL slug, and edit the TypeScript source. Select **Private** or **Public**, then **Save and deploy**. Endpoints appear alongside other artifacts in the library with an **Endpoint** label; the **Endpoints** filter shows them together with legacy scripts. Selecting an endpoint loads its source without running it.

For any artifact, the **URL /** field and access selector control its direct link. **Save link** updates the settings; **Open** visits the URL and **Copy URL** copies its absolute address. Updating the source keeps the chosen URL. Changing the slug changes the URL; old URLs are not aliases.

**Save and deploy** validates and saves the working source. A successful update serves immediately, without a separate publishing step. A failed validation keeps the previous working revision and access settings serving. If the first save is invalid, its chosen slug is retained with the draft until a valid correction creates the URL. The **Versions** menu lets you read older revisions; **Restore and deploy** makes the selected revision current. **Download** saves the source project.

Open **Requests** to choose an HTTP method, a path relative to the endpoint URL, headers as a JSON object, and a text body for methods other than GET and HEAD. **Send request** invokes the current saved revision, even when you are browsing a historical revision or have unsaved edits. The response displays its status, headers, and decoded text body. Binary bodies are shown as base64. Returned HTML is displayed as text.

**Schedule** in the More actions menu configures recurring runs and shows run history; each run links to its logs. Under **Settings**, enter a name and value and select **Save secret**; the value field clears after saving. Stored secret values are never loaded into the editor or source history.

These controls are available on Cloudflare, celld, and `artifacts host`. The file-based `artifacts web` gallery previews React artifacts and does not execute servers.

## Server handler

A server implements a standard Workers fetch handler. It can return JSON, HTML, binary data, redirects, or any other HTTP response supported by the runtime. Webhooks are one application of this contract.

```ts
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Hello", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<ServerEnv>;
```

`ServerEnv` is available during type checking. It contains `secrets: Record<string, string>`, `sql: SqlStorage`, and `storage` with `sql`, `kv` and `transactionSync`. Outbound `fetch` is available. `ctx.waitUntil` can extend background work associated with a request. Servers can import supported `cloudflare:` and `node:` builtins. Use relative helper modules and exact npm dependencies through the project source editor or MCP project fields. Code must be compatible with the Workers runtime. Use [schedules](#schedules-and-execution-history) for recurring runs.

An endpoint receives every path under its URL, relative to the slug: a request to `/stripe-webhook/events?id=1` reaches the handler as `/events?id=1`, and `/stripe-webhook` itself arrives as `/`. Requests preserve their methods, query strings, and body bytes. The gateway strips cookies and Cloudflare Access assertion/service-token headers; private routes also strip the authorization credential used for management authentication. Paths under `/<slug>/_artifact/` are reserved.

Use `env.secrets.NAME` for a configured secret. For example, a handler can verify a provider signature against the original request body.

Each artifact has its own persistent SQLite storage. The database survives source updates and revision restores:

```ts
export default {
  async fetch(request, env) {
    env.sql.exec("create table if not exists visits (at text not null)");
    env.storage.transactionSync(() => {
      env.sql.exec("insert into visits values (?)", new Date().toISOString());
    });
    const row = env.sql.exec<{ count: number }>(
      "select count(*) as count from visits",
    ).one();
    return Response.json(row);
  },
} satisfies ExportedHandler<ServerEnv>;
```

Do not assume an in-memory global persists between requests or updates. On Cloudflare, each execution is limited to 30 seconds of CPU and 50 subrequests, in addition to the Workers runtime limits. The celld configuration omits these per-request budgets because the pinned celld runtime does not enforce them. Logs retain the latest 100 entries with messages capped at 2 KiB. Secret strings are redacted from captured console output; handlers still control their own response bodies and outbound requests.

A server can also export `class ArtifactServer extends DurableObject` from `cloudflare:workers`, using `this.ctx.storage` and `this.env.secrets`. Both forms use the same database, so existing class-based servers keep their data when rewritten as handlers.

## Access

For provider setup, MCP OAuth, and the credentials accepted by private URLs, see
[authentication and access](authentication.md).

Links default to **Private** and use the artifact's existing library permissions. Management APIs and the gallery remain authenticated. Setting a link to **Public** allows external callers to invoke or view it; a public endpoint can implement its own authentication through request headers or signatures, and accepts requests from other origins like any public API.

If Cloudflare Access protects the deployment's entire hostname, configure an Access bypass for the intended public paths so external callers can reach the Worker. The artifact's access setting does not override an Access policy that blocks the request before it reaches the application.

HTML served at artifact URLs is sandboxed with a response Content Security Policy to isolate it from the management origin. Server responses cannot set cookies through these routes. This allows HTML handlers while keeping the gallery session separate.

## MCP

Agents use `artifact_write` with `server` and no `contents` to create an endpoint, then `artifact_read`, `artifact_edit`, `artifact_history`, `artifact_restore`, `artifact_request`, `artifact_logs`, `artifact_runs`, `artifact_schedule`, and `artifact_secrets` to manage it. `artifact_read` and `artifact_edit` select the server by default when an artifact has no UI. `artifact_link` sets the slug and access for `kind: "artifact"`, a legacy `kind: "script"`, or a native Worker with `kind: "app"`. Creation and link results include the resulting URL.

`artifact_request` takes a request object with `path` (relative to the artifact URL), `method`, `headers` as an array of `[name, value]` pairs, and an optional base64 `body`. Its structured result contains `response` with `status`, `statusText`, `headers`, and an optional base64 `body`. For example:

```json
{
  "name": "artifact_request",
  "arguments": {
    "name": "echo",
    "request": {
      "path": "/",
      "method": "POST",
      "headers": [["content-type", "text/plain"]],
      "body": "aGVsbG8="
    }
  }
}
```

Adding `contents` later gives the artifact a UI; the server then answers only under `/api`. Passing `contents: null` removes the UI again.

## Third-party dependencies

Artifacts and legacy scripts accept an optional `project` alongside their entrypoint source:

```json
{
  "files": { "lib/message.ts": "export const message = 'Hello';" },
  "dependencies": { "hono": "4.13.7" }
}
```

Import helpers with relative paths such as `./lib/message`, and import packages normally. The gallery source editor provides a file picker, add/remove helper controls, and an exact-version dependency editor. `artifact_read` and `artifact_edit` (and the legacy `script_read` and `script_edit`) accept `file` to target a helper. Omit `project` on write to retain it; when supplied, its files and dependency declarations replace the whole project. Read responses include the complete project snapshot. Historical views are read-only and restoring a revision restores every source file and its dependency lock.

Dependency declarations accept exact npm versions only. The service resolves packages when declarations change, verifies tarball integrity, and archives the package source and types with the artifact revision. Edits with unchanged dependencies, replay, and execution use this archived snapshot without registry access. Package installation scripts never execute. Download/decompression, file counts, and stored content are bounded. The service only accesses the public npm registry and rejects arbitrary tarball origins.

The compiler currently supports one version of each package. Conflicting transitive requirements and missing required peers produce explicit diagnostics. Browser React, ReactDOM and React Router dependencies use Artifacts' own compatible runtime so hooks do not load a second React. Packages must support the browser or Workers environment; native addons and packages requiring a Node process are unsupported. Source archives contain up to 64 helper files (1 MiB total) and up to 64 resolved packages with a dependency lock bounded to 4,096 files and 8 MiB. The entrypoint remains limited to 256 KiB.

Hosted Cloudflare and celld deployments use the same project contract. Local artifact CLI and MCP also persist the project beside the artifact and carry its files and dependency snapshot through history and remix. Use `artifacts write NAME --file SOURCE --project PROJECT_JSON`, where the JSON contains files and exact dependency declarations, or pass `project` to local MCP `artifact_write`. Source-only local writes preserve the project; update helpers by replacing `project.files`. Servers and the legacy script tools remain hosted-only.

Agents can call `artifact_guide` with topic `backend` to retrieve the server contract through MCP.

Hosted `artifact_read`, legacy `script_read`, and JSON source snapshots include a
`revision_token` for the complete project. Pass it as `expected_revision` on a
full write to reject changes made since the read, including backend, helper and
dependency changes. `expected_revision: null` requires a new name. Omit the field
for existing unconditional-write behavior. Browser editors use this guard,
retain unsaved buffers while switching items or revisions, and warn before
leaving the gallery. A conflict offers comparison with saved source or an
explicit reload; your edits remain available until you choose to discard them.

## Remix

Select a working copy or historical revision in the gallery, then **Remix** and choose a new name. MCP offers `artifact_remix`, with `new_name` and exactly one of `name` or `version_id`; remixing a [legacy script](#legacy-scripts) creates a server-only artifact. Hosted calls optionally accept a new `slug`; otherwise it defaults to the destination name. Sources and destinations belong to the authenticated library and selected workspace.

A remix creates a separate artifact and records its immutable source revision as provenance. Artifact browser and server sources stay paired. The new artifact starts with empty runtime data and no copied secret values; its hosted URL starts private. Destination names cannot overwrite existing drafts or archived artifacts, and URL collisions are rejected. Invalid source remains saved as a remix draft, with validation diagnostics; it receives a working URL only after successful validation. Remixing does not execute the request handler.

## Schedules and execution history

Hosted Cloudflare and celld servers can schedule artifact servers, including endpoints and legacy scripts, with native Durable Object alarms. Configure **Schedule** in the gallery, or call `artifact_schedule` with `name` and `action: "set"`. Supply exactly one of `interval_seconds` (at least 60) or a five-field `cron` expression. Cron accepts an IANA `timezone`, defaulting to `UTC`. Supply a relative HTTP `request` (path, method, headers, optional base64 body); the default is GET `/`.

Use `action: "get"`, `"pause"`, `"resume"`, or `"run_now"` to inspect or control the schedule. Run-now executes the saved request, including while paused. Each artifact has one schedule. Removing an artifact's server pauses its schedule. The local filesystem CLI/stdio runtime does not execute backends or run a scheduler; use `artifacts server` for local scheduled execution.

Schedules execute the latest validated revision, not an invalid draft or a historical preview. An occurrence is durably claimed before calling user code; missed intervals are skipped rather than accumulated. Failures and uncertain interrupted invocations are not automatically replayed. Application handlers should make repeated writes idempotent when that matters. A local celld server must be running for alarms to execute.

`artifact_runs` exposes the latest 100 of up to 1,000 retained executions: revision, trigger, start/end times, duration, HTTP status and outcome. The gallery's **Run history** shows the same records. These records live in host-owned SQLite, separate from the user handler's database, and survive code updates and source restores. An `interrupted` record means completion is unknown and side effects may already have occurred.

`artifact_logs` returns the latest 100 console lines, request summaries and errors, and can be filtered by `run_id` from `artifact_runs`. Success describes the HTTP handler returning a response, not completion of `waitUntil` tasks or streamed response bodies. Requests from a UI through `artifactFetch` or `artifact_request` also include response serialization.

## Moving between libraries

In the hosted gallery, **Move to team** changes an item's owner from your personal
library to the deployment's team. **Move to personal** moves a team item into the
signed-in user's personal library, removing other team members' management access.
Artifacts and legacy scripts retain their complete source history, helper modules,
backend data, files, secrets, schedules, and existing URLs. The URL's **Private** or
**Public** setting is separate and remains unchanged. Existing destination names
cause a conflict; moves never replace another item.

The authenticated HTTP operation is
`POST /api/library/move?library=private&workspace=default` with
`{"kind":"artifact","name":"handler","library":"team"}`. The query selects the
current owner and the body selects the destination. Use `kind: "script"` for a
legacy script, and swap `private`/`team` for the reverse direction. A personal destination
is always the caller's own library. Operations admitted before a move may finish,
and existing file transfer grants remain valid until their usual expiry.

## Legacy scripts

Before endpoints, HTTP handlers were a separate item type created with `script_write` or the gallery's former **New script** command. Existing scripts keep their storage, secrets, schedules, run history and URLs; nothing is migrated. They appear in the library with a **Legacy script** label, and in `artifact_list` results as `legacy_scripts`.

`script_write`, `script_read`, `script_edit`, `script_list`, `script_history`, `script_version`, `script_restore`, `script_remix`, `script_run`, `script_logs`, `script_runs`, `script_schedule`, `script_secrets`, `script_export`, `script_import` and `script_guide` keep their contracts, including creating new scripts. Agents do not need them: when no artifact has the requested name, `artifact_read`, `artifact_edit`, `artifact_write` (with `server` only), `artifact_history`, `artifact_version`, `artifact_restore`, `artifact_export`, `artifact_request`, `artifact_runs`, `artifact_logs`, `artifact_schedule` and `artifact_secrets` operate on the legacy script. A legacy script cannot gain a UI, and a new artifact cannot take a legacy script's name.

A script handler receives the full deployment path, such as `/stripe-webhook/events`, and `ScriptEnv` provides `secrets` and `sql`. To move a script onto the artifact runtime, remix it: `artifact_remix` with the script's `name` or `version_id` (or **Remix** in the gallery) creates a server-only artifact from its source, which compiles unchanged because `ScriptEnv` is accepted as an alias of `ServerEnv`. The copy starts with empty storage, no secrets, no schedule and a private URL, and its handler receives paths relative to its own URL, so adjust any code that matches on the slug. `artifact_import` also accepts script archives from `script_export` and creates server-only artifacts.
