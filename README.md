# Sidequery Artifacts

<img width="1417" height="945" alt="Screenshot 2026-09-06 at 10 36 49 PM" src="https://github.com/user-attachments/assets/87b51b80-660d-449a-8e80-acbeb5db15e9" />

Local, source-backed React artifacts for agents. Browse them in a web gallery,
read and edit them through CLI or MCP, and retain raw-source version history.
Herdr is an optional integration for opening artifacts beside a terminal agent.

The local runtime uses Bun with local files and SQLite. MCP Apps hosts render the
interactive artifact directly inside chat when an agent creates or shows it.
An experimental Cloudflare runtime provides an HTTP MCP server and gallery in your own or a shared account; see [Cloudflare setup](docs/cloudflare.md).

## Requirements

- Bun 1.4.0 or newer
- Linux or macOS

Only Herdr pane opening requires Herdr 0.8.2+ and
[Terminal Browser](https://github.com/zenbu-labs/terminal-browser).
The gallery, source operations, history, typechecking and compilation work without them.

## Install

Install the CLI with Bun; a source checkout is not required.

```bash
bun add --global @sidequery/artifacts
artifacts write overview --file overview.artifact.tsx
artifacts web --port 4784
```

Open `http://127.0.0.1:4784`. The package includes the local CLI, stdio MCP
server, gallery, and the prebuilt Worker and assets used by the optional native
artifacts server. It does not build from source during installation.

For a stdio MCP client, configure the installed command directly:

```json
{
  "command": "artifacts",
  "args": ["mcp", "--dir", "/absolute/path/to/workspace/artifacts"]
}
```

Agents without MCP can use the CLI for the same artifact operations.

## Run from source

From the checkout:

```bash
bun install --frozen-lockfile
bun run artifacts write overview --file examples/overview.artifact.tsx
bun run artifacts web --port 4784
```

Open `http://127.0.0.1:4784`. Your working artifacts and UI state are ignored by
this repository; reusable checked-in samples belong in `examples/`.
`bun run artifacts` uses the same CLI directly from this checkout.

## Optional Herdr integration

```bash
herdr plugin install zenbu-labs/terminal-browser/herdr-plugin --yes
herdr plugin link /path/to/artifacts
```

Run `bun install --frozen-lockfile` in the checkout before linking it. The plugin
ID and pane entrypoint are `herdr.artifacts` and `artifacts`. Relink an existing
checkout to register the new plugin name.

## Upgrading from Canvas

Use the `artifacts` CLI and `artifact_*` MCP tools. New sources use `.artifact.tsx`,
`sidequery/artifacts`, and SDK names such as `useArtifactState` and `artifactFetch`.
Existing `.canvas.tsx` sources, their sidecars, historical SDK imports and exported
names remain readable and compilable. Existing workspace and application-data
directories are reused when no new directory exists; files and databases are not
moved. New `ARTIFACTS_DIR`, `ARTIFACTS_HISTORY_DB`, and `ARTIFACTS_DATA_HOME` overrides
take precedence over their legacy equivalents. Existing hosted storage identities
are retained; see [Cloudflare setup](docs/cloudflare.md).

## Agent workflow

Call `artifact_guide` before creating an artifact if you have not read it in the current
conversation. It covers the SDK contract, host APIs, restrictions, and validation.
Import standard React hooks from `sidequery/artifacts` for component state and effects.
Use `useArtifactState(key, defaultValue)` when you want host-backed state; persistence
depends on the view.

Artifacts live at `<workspace>/artifacts/<name>.artifact.tsx`. Import the SDK from
`sidequery/artifacts` (`herdr/canvas` and `cursor/canvas` remain compatibility aliases).
Projects can also import their declared helper files and pinned dependencies. Use the CLI or MCP:

```bash
artifacts list
artifacts write overview --file examples/overview.artifact.tsx
artifacts typecheck overview
artifacts open overview
artifacts mcp
```

`open` typechecks and bundles with Bun, then opens the `herdr.artifacts` `artifacts`
pane entrypoint. That pane starts its own loopback server and runs
Terminal Browser internally in `--app-mode`. Closing the pane closes its browser
session and loopback server. `--no-open` is the explicit development-only path
that starts a detached server and returns its URL.

MCP tools: `artifact_list`, `artifact_read`, `artifact_edit`, `artifact_write`, `artifact_typecheck`, `artifact_compile`,
`artifact_open`. `artifact_write` returns `Artifact TypeScript check` diagnostics in
the tool result.

## Inline artifacts in chat

Configure the stdio MCP server above in a client that supports MCP Apps. Ask the
agent to create an artifact: a successful `artifact_write` displays the actual React
artifact inline, including charts, forms and interactive controls. To show an
existing artifact, call `artifact_open({name: "overview"})`. Successful `artifact_edit`
and `artifact_restore` also return an updated inline preview. These are artifact
views, without the gallery or tool-management controls.

Inline views fit their content, grow and shrink as it changes, and scroll within
a 600px maximum height (or a smaller maximum supplied by the host). A host with
a fixed container height takes precedence. The chat controls the width; narrow
views wrap text and keep oversized content scrollable.

When the host advertises fullscreen support, **Expand** opens the artifact in the
host's fullscreen view. **Exit fullscreen** returns it to the conversation.
Fullscreen uses the available viewport with an independently scrolling artifact.
Switching modes preserves controls and their current state. Hosts can also change
the mode themselves; unavailable controls are hidden, and rejected requests leave
the current view usable. This uses MCP Apps display modes, not browser fullscreen.

The viewer is a self-contained `ui://artifacts/viewer.html` MCP App resource. Tool
results carry the compiled snapshot in UI-only `_meta`; normal text results stay
compact. No web server, external asset hosting or Herdr installation is needed.
Clients without MCP Apps support receive the normal text/diagnostic results;
they cannot display the interactive artifact.

Inline views begin with saved artifact state and keep subsequent interactions local
to that view, like gallery previews. They do not overwrite the working artifact's
state sidecar. Archived views support `version_id` and optional `event_id`, and
recompile the saved raw source with the installed SDK. Delivering a preview
archives raw source and records a preview event; it does not prove a human saw it.
Compiled JavaScript is never stored in the history database.

The artifact follows the chat host's theme. `promptAgent` requests a user message
through the host, and `openUrl` requests opening an HTTP(S) link. Host rejection
is shown in the view. `openFile` reports that local file opening is unavailable
in chat. These actions remain subject to the host's capabilities and permissions.

MCP `artifact_open` now defaults to inline display. To open a Herdr pane explicitly,
use `artifact_open({name: "overview", target: "herdr"})`. Similarly,
`artifact_write({name, contents, target: "herdr"})` also opens a pane. The legacy
write `open` flag is accepted, but inline display is automatic regardless of it.
CLI `open` continues to open a Herdr pane.

## Native artifact servers and SQLite

The optional local native runtime starts in the foreground with `artifacts server`.
It downloads a pinned, checksummed `celld` binary on first use and stores its
runtime and SQLite state under the operating system's application-data directory.
Use `artifacts server start`, `artifacts server stop`, `artifacts server status`, and
`artifacts server logs` for the opt-in background service. See
[`docs/daemon.md`](docs/daemon.md) for lifecycle and login-service details.

The native server exposes its gallery at `http://127.0.0.1:4786` and its HTTP MCP
endpoint at `http://127.0.0.1:4786/mcp`. Configure an HTTP MCP client against that
endpoint to create artifacts with server source and call `artifact_request`. The
`artifacts web` gallery and `artifacts mcp` stdio server continue to use workspace files
and the local history database; they do not migrate or synchronize artifacts with
the native server.

Hosted Cloudflare artifacts can pair the browser `.artifact.tsx` with a native
`ArtifactServer`. The server is a generated Durable Object class and uses its own
SQLite through `ctx.storage.sql` and key/value storage through `ctx.storage.kv` directly. The browser calls it with
`artifactFetch`, which accepts a path and standard `RequestInit` and returns a
standard `Response`:

```tsx
import { Button, Text, artifactFetch, useState, useEffect } from "sidequery/artifacts";

export default function Counter() {
  const [value, setValue] = useState<number | null>(null);
  async function load(method = "GET") {
    const response = await artifactFetch("/counter", { method });
    if (!response.ok) throw new Error(`Counter failed (${response.status})`);
    setValue((await response.json() as { value: number }).value);
  }
  useEffect(() => { void load(); }, []);
  return <><Text>Count: {value ?? "loading"}</Text><Button onClick={() => { void load("POST"); }}>Increment</Button></>;
}
```

```ts
import { DurableObject } from "cloudflare:workers";

export class ArtifactServer extends DurableObject {
  fetch(request: Request): Response {
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key, value integer not null)");
    this.ctx.storage.sql.exec("insert or ignore into counter values (1, 0)");
    if (request.method === "POST") this.ctx.storage.sql.exec("update counter set value = value + 1 where id = 1");
    const row = this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one();
    return Response.json(row);
  }
}
```

The complete checked-in pair is
[`examples/counter.artifact.tsx`](examples/counter.artifact.tsx) and
[`examples/counter.artifact.server.ts`](examples/counter.artifact.server.ts).
Seed it into the hosted runtime with `bun run seed:cloudflare default counter`.
`artifactFetch` carries ordinary HTTP method, headers and body through the Artifact
host; it does not expose an internal endpoint or bearer credential to artifact
code. Use relative paths. Cross-origin and protocol-relative URLs are rejected,
and request and response bodies are limited to 256 KiB.

Hosted `artifact_write` accepts `server` source alongside `contents`. Omitting
`server` preserves the existing server; passing `null` removes it without
deleting its database. Use `artifact_read` or `artifact_edit` with `part: "server"`
for targeted server changes. Client and server source are versioned and restored
together. The database is live state keyed by library, workspace and artifact name:
editing or restoring source reloads the code while preserving that state, and
opening an archived version does not restore an old database snapshot.

Private artifacts receive databases isolated to the verified signed-in user. A
team artifact shares one database with members authorized for that deployment's
team library. Private and team artifacts with the same workspace and name remain
separate. Generated servers receive Durable Object storage; ordinary D1, R2 and
custom Worker bindings are not provided. The local Bun CLI, stdio MCP server and
gallery do not execute artifact servers, so `artifactFetch` reports that server
requests are unavailable there.

Hosted artifacts and the managed local celld server also provide **per-artifact
files** through `artifactFiles.upload`, `list`, `read`, `download`, and `delete`.
Files use native R2, remain live across source edits, and need no server code.
Uploads support up to 25 MiB; binary transfers bypass the 256 KiB request bridge.
Public artifact links expose files read-only. See [file storage and deployment](docs/files.md)
and [the file artifact example](examples/files.artifact.tsx).

Hosted deployments choose `AUTH_MODE=access` for the existing Cloudflare Access
setup or `AUTH_MODE=better-auth` for provider-configurable sign-in. Better Auth
runs inside the Artifacts Worker with a deployment-owned D1 database; it does not
require a central Artifactss authentication service or offer password registration.
Deployers can pass any supported Better Auth social-provider configuration,
configure generic OIDC, or extend the TypeScript provider seam. The gallery and
remote MCP OAuth flow resolve to the same user identity. See
[Cloudflare setup](docs/cloudflare.md) for provider examples, D1 migrations and
admission rules.

## Scripts and direct URLs

Hosted artifacts and standalone TypeScript scripts can have user-chosen root URLs
such as `/sales-dashboard` and `/my-handler`. Artifact links open the interactive
UI with its backend; script links invoke a standard Workers HTTP handler.
Manage scripts, secrets, history, logs and link access through the gallery or MCP.
See [Scripts and direct artifact links](docs/scripts.md).

## Targeted reads and edits

Use `read` / `artifact_read` to retrieve only the needed working-source lines, and
`edit` / `artifact_edit` to change them without resending the whole artifact. These
operations share the same implementation across CLI and MCP. They accept an artifact
name (with optional `.artifact.tsx` suffix), not a path; symlinks are rejected.

```bash
bun run src/cli.ts read overview --start-line 5 --end-line 12
bun run src/cli.ts edit overview --stdin <<'JSON'
{"edits":[{"old_text":"<H1>Overview</H1>","new_text":"<H1>Issue overview</H1>"}]}
JSON
```

`read` returns JSON containing `source`, `start_line`, `end_line`, `total_lines`,
`next_line`, and `source_hash` (SHA-256 of the **entire** file). Line numbers are
1-based and inclusive. The default is 200 lines starting at line 1; `next_line`
identifies the next page or is null. Explicit end lines are clamped to EOF; a
start past EOF is rejected. Empty files return empty source and `end_line: 0`.
Line endings are preserved so returned text can be used for exact replacements.

MCP uses `artifact_read({name, start_line?, end_line?})` and
`artifact_edit({name, edits, expected_hash?})`. CLI `edit` reads the same JSON body
without `name` from stdin or `--file PATH`. Each edit has `old_text` and `new_text`.
Include the hash returned by `read` as `expected_hash` to reject stale edits.

Replacements run sequentially in memory. Each non-empty `old_text` must match
exactly once in the result of earlier replacements; missing or ambiguous matches
reject the entire batch without writing. Use more surrounding text to disambiguate.
Empty `new_text` deletes the match. The completed batch is written with atomic
replacement and an optimistic source check, then typechecked once. As with
`write`, typecheck errors **leave the changed source applied**; edit reports
`applied: true, ok: false`, CLI exits 1, and MCP marks the result as an error.
This is not a strict filesystem compare-and-swap against arbitrary external writers.

Edit results include `changed`, `edits_applied`, the new `source_hash`, and
diagnostics, but no source echo. Edits do not modify saved UI state or create
history revisions until successfully served. Existing write/open behavior is
unchanged: MCP supports `artifact_write` with `open: true`; CLI uses separate
`write` and `open` commands.

## Artifact history

Every successfully served source revision is archived automatically, including
edits made directly to a `.artifact.tsx` file. History stores **authored source,
dependency snapshots, and metadata**, using Bun's built-in `bun:sqlite`; compiled
artifact JavaScript stays in memory. Unchanged source and project reuse their latest revision. Each page response records
a separate serve event with its initial UI state, pane/session context, and
runtime identity. A serve event means the server returned a page, not that a
human viewed it. Unserved intermediate edits are not captured automatically.

```bash
bun run src/cli.ts history                    # all artifacts in this workspace
bun run src/cli.ts history midnight-greenhouse
bun run src/cli.ts show VERSION_ID            # raw source, metadata, serve events
bun run src/cli.ts show VERSION_ID --source   # raw TSX on stdout
bun run src/cli.ts open --version VERSION_ID  # open an archived version in a pane
bun run src/cli.ts open --version VERSION_ID --event EVENT_ID
bun run src/cli.ts restore VERSION_ID         # restore source as a new revision
```

Equivalent MCP tools: `artifact_history` (optional `name`), `artifact_version`
(`version_id`), `artifact_open` (`version_id`, optional `event_id` and `placement`),
and `artifact_restore` (`version_id`). Existing `artifact_list` lists working files;
`artifact_history` also includes artifacts whose files have been deleted.
`artifact_open` accepts either `name` for a working file or `version_id` for history.

Reopening compiles the saved source with the **currently installed SDK and Bun**.
An SDK upgrade can change its appearance or make old source fail to compile.
The archived view starts with the selected event's state (by default the latest
live serve), and its interactions remain local to that page. It does not poll
the working file or write to the working artifact's saved state. This preserves
initial state, not a recording of every interaction. Page bundle URLs identify
the source version and in-memory SDK generation so concurrent source/SDK edits
cannot mix the page and bundle. If an old SDK generation has been evicted from
memory, its bundle request asks for a page reload instead of serving different code.

Restore saves the current working source first—even an invalid, unserved draft—
then writes the selected source and appends a new revision linked to the original.
It keeps later history and the working artifact's `.artifact.data.json` state.
Restore uses an atomic file replacement and an optimistic source check; if an
edit is detected after the preservation snapshot it stops and leaves that edit
untouched. Symlinked source files are rejected for serving and restoration.
Typecheck diagnostics are returned after restoration. File replacement and SQLite
are separate operations: the original working source is durably archived before
replacement; an interrupted restore may be captured on the next successful serve.

The database survives pane closure and lives at:

- macOS: `~/Library/Application Support/artifacts/history.sqlite`
- Linux: `$XDG_DATA_HOME/artifacts/history.sqlite`, defaulting to
  `~/.local/share/artifacts/history.sqlite`

Override with `ARTIFACTS_HISTORY_DB` or `--history-db PATH`. All commands also
accept `--dir PATH` to select an artifacts directory. Artifact IDs are stable within
that directory and name; renames or different worktrees are separate artifacts.
SQLite uses WAL mode with a busy timeout for concurrent panes. History is retained
without automatic pruning; it may contain embedded data and saved UI state.
For backups, use SQLite's backup facilities rather than copying an active database
file without its WAL.

## Web gallery

```bash
bun run src/cli.ts web --port 4784
```

Open `http://127.0.0.1:4784` to search working artifacts and archived versions,
preview one at a time, inspect raw source, or download a `.artifact.tsx` file.
The gallery defaults to this project; its all-projects filter includes archived
artifacts from other projects in the same database. It does not scan other projects
for unarchived working files. Use `--dir PATH` and `--history-db PATH` to select a
workspace and database, or `--port 0` for an available port printed on startup.

The server runs in the foreground until Ctrl-C. Gallery previews have isolated,
temporary interaction state and run in sandboxed frames; they cannot access the
gallery page. Viewing a working copy archives its current source. Closing a browser
tab does not stop this explicitly started web server. The gallery offers no restore
or delete action; restoring working source remains an explicit CLI/MCP operation.

## Development

See the [source map](docs/architecture.md) for runtime boundaries, MCP modules,
hosted services, and Herdr action entrypoints.

```bash
bun run test
bun run test:e2e
bun run test:mcp-ui
bun run test:package
bun run typecheck
```

`bun run test` is the unit/service suite. `bun run test:e2e` builds a Docker image
with real Herdr and Terminal Browser, starts Herdr on a PTY, verifies
that the pane is owned by `herdr.artifacts`, and proves its server stops when the
pane closes.

GitHub Actions runs the typecheck and unit/service suite with Bun 1.4.0.
The root Dockerfile is an integration-test environment, not a production image.
`bun run test:mcp-ui` exercises the real artifact in Chromium with an MCP Apps host.
Install its browser first with `bun x playwright install chromium`. CI runs this
browser suite, the unit/service suite, and a clean tarball install that exercises
the installed CLI, gallery, compilation, and stdio MCP server.

## Trust boundary

This is a local tool, not an authenticated multi-user service. Keep the web
server on loopback; do not expose it through a public proxy. Source checks reject
unsupported imports and APIs, but they are not a general-purpose security sandbox
for hostile JavaScript. Gallery previews run in isolated browser frames. Inline
artifacts execute inside the chat host's MCP Apps sandbox; use trusted local artifact
source, as for the other local views. Artifact
source and saved state can contain private data; keep the history database private.

## Projects, remix, and scheduled runs

Artifacts and scripts support helper source files and pinned package dependencies.
Use the gallery's source file picker and Dependencies editor, or pass
`project: { files: { "lib/helper.ts": "..." }, dependencies: { "package": "1.2.3" } }`
to the write tool. Local CLI writes accept `--project PROJECT_JSON`; targeted
reads and edits accept `--source-file lib/helper.ts`. Source history retains the
resolved dependency snapshot as well as authored files.

Use **Remix** in the gallery, `artifact_remix` / `script_remix` through MCP, or
`artifacts remix SOURCE NEW_NAME` locally. Copies retain source provenance and start
with fresh state, storage, secrets, and private hosted URLs.

Hosted and celld backends expose **Schedule** and **Run history** controls. Native
alarms support intervals and cron expressions with timezones, pause/resume, and
run-now. Run records live in host-owned SQLite. See
[project, remix, and scheduling contracts](docs/scripts.md) for details and limits.
