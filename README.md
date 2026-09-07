# Canvas

<img width="1417" height="945" alt="Screenshot 2026-09-06 at 10 36 49 PM" src="https://github.com/user-attachments/assets/87b51b80-660d-449a-8e80-acbeb5db15e9" />

Local, source-backed React artifacts for agents. Browse them in a web gallery,
read and edit them through CLI or MCP, and retain raw-source version history.
Herdr is an optional integration for opening artifacts beside a terminal agent.

The local runtime uses Bun with local files and SQLite. MCP Apps hosts render the
interactive canvas directly inside chat when an agent creates or shows it.
An experimental Cloudflare runtime provides an HTTP MCP server and gallery in your own or a shared account; see [Cloudflare setup](docs/cloudflare.md). The repository is named `canvas`; an existing
checkout can remain in a folder named `herdr-canvas`.

## Requirements

- Bun 1.4.0 or newer
- Linux or macOS

Only Herdr pane opening requires Herdr 0.8.2+ and
[Terminal Browser](https://github.com/zenbu-labs/terminal-browser).
The gallery, source operations, history, typechecking and compilation work without them.

## Run from source

From the checkout:

```bash
bun install --frozen-lockfile
bun run canvas write overview --file examples/overview.canvas.tsx
bun run canvas web --port 4784
```

Open `http://127.0.0.1:4784`. Your working canvases and UI state are ignored by
this repository; reusable checked-in samples belong in `examples/`.
The package is private and is not published to a registry. The CLI has a `canvas`
bin entry for future packaging; `bun run canvas` works directly from this checkout.

For a stdio MCP client, configure the command `bun` with arguments:

```json
["run", "/absolute/path/to/canvas/src/cli.ts", "mcp", "--dir", "/absolute/path/to/workspace/canvases"]
```

Use your actual checkout path, including `herdr-canvas` if that is its folder name.
Agents without MCP can use the CLI for the same artifact operations.

## Optional Herdr integration

```bash
herdr plugin install zenbu-labs/terminal-browser/herdr-plugin --yes
herdr plugin link /path/to/herdr-canvas
```

Run `bun install --frozen-lockfile` in the checkout before linking it. The plugin
ID remains `herdr.canvas`. Existing SDK imports (`herdr/canvas`, `cursor/canvas`),
`HERDR_CANVAS_*` environment variables and history paths are retained for
compatibility; the project rename does not migrate or reset stored artifacts.

## Agent workflow

Canvases live at `<workspace>/canvases/<name>.canvas.tsx` and may import only
from `herdr/canvas`. Use the CLI or MCP:

```bash
bun run src/cli.ts list
bun run src/cli.ts write overview --file examples/overview.canvas.tsx
bun run src/cli.ts typecheck overview
bun run src/cli.ts open overview
bun run src/cli.ts mcp
```

`open` typechecks and bundles with Bun, then opens the `herdr.canvas` `canvas`
pane entrypoint. That pane starts its own loopback server and runs
Terminal Browser internally in `--app-mode`. Closing the pane closes its browser
session and loopback server. `--no-open` is the explicit development-only path
that starts a detached server and returns its URL.

MCP tools: `canvas_list`, `canvas_read`, `canvas_edit`, `canvas_write`, `canvas_typecheck`, `canvas_compile`,
`canvas_open`. `canvas_write` returns `Canvas TypeScript check` diagnostics in
the tool result.

## Inline canvases in chat

Configure the stdio MCP server above in a client that supports MCP Apps. Ask the
agent to create a canvas: a successful `canvas_write` displays the actual React
canvas inline, including charts, forms and interactive controls. To show an
existing canvas, call `canvas_open({name: "overview"})`. Successful `canvas_edit`
and `canvas_restore` also return an updated inline preview. These are canvas
views, without the gallery or tool-management controls.

Inline views fit their content, grow and shrink as it changes, and scroll within
a 600px maximum height (or a smaller maximum supplied by the host). A host with
a fixed container height takes precedence. The chat controls the width; narrow
views wrap text and keep oversized content scrollable.

When the host advertises fullscreen support, **Expand** opens the canvas in the
host's fullscreen view. **Exit fullscreen** returns it to the conversation.
Fullscreen uses the available viewport with an independently scrolling canvas.
Switching modes preserves controls and their current state. Hosts can also change
the mode themselves; unavailable controls are hidden, and rejected requests leave
the current view usable. This uses MCP Apps display modes, not browser fullscreen.

The viewer is a self-contained `ui://canvas/viewer.html` MCP App resource. Tool
results carry the compiled snapshot in UI-only `_meta`; normal text results stay
compact. No web server, external asset hosting or Herdr installation is needed.
Clients without MCP Apps support receive the normal text/diagnostic results;
they cannot display the interactive canvas.

Inline views begin with saved canvas state and keep subsequent interactions local
to that view, like gallery previews. They do not overwrite the working canvas's
state sidecar. Archived views support `version_id` and optional `event_id`, and
recompile the saved raw source with the installed SDK. Delivering a preview
archives raw source and records a preview event; it does not prove a human saw it.
Compiled JavaScript is never stored in the history database.

The canvas follows the chat host's theme. `promptAgent` requests a user message
through the host, and `openUrl` requests opening an HTTP(S) link. Host rejection
is shown in the view. `openFile` reports that local file opening is unavailable
in chat. These actions remain subject to the host's capabilities and permissions.

MCP `canvas_open` now defaults to inline display. To open a Herdr pane explicitly,
use `canvas_open({name: "overview", target: "herdr"})`. Similarly,
`canvas_write({name, contents, target: "herdr"})` also opens a pane. The legacy
write `open` flag is accepted, but inline display is automatic regardless of it.
CLI `open` continues to open a Herdr pane.

## Targeted reads and edits

Use `read` / `canvas_read` to retrieve only the needed working-source lines, and
`edit` / `canvas_edit` to change them without resending the whole canvas. These
operations share the same implementation across CLI and MCP. They accept a canvas
name (with optional `.canvas.tsx` suffix), not a path; symlinks are rejected.

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

MCP uses `canvas_read({name, start_line?, end_line?})` and
`canvas_edit({name, edits, expected_hash?})`. CLI `edit` reads the same JSON body
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
unchanged: MCP supports `canvas_write` with `open: true`; CLI uses separate
`write` and `open` commands.

## Artifact history

Every successfully served source revision is archived automatically, including
edits made directly to a `.canvas.tsx` file. History stores **raw TSX source and
metadata only**, using Bun's built-in `bun:sqlite`; compiled JavaScript stays in
memory. Unchanged source reuses its latest revision. Each page response records
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

Equivalent MCP tools: `canvas_history` (optional `name`), `canvas_version`
(`version_id`), `canvas_open` (`version_id`, optional `event_id` and `placement`),
and `canvas_restore` (`version_id`). Existing `canvas_list` lists working files;
`canvas_history` also includes artifacts whose files have been deleted.
`canvas_open` accepts either `name` for a working file or `version_id` for history.

Reopening compiles the saved source with the **currently installed SDK and Bun**.
An SDK upgrade can change its appearance or make old source fail to compile.
The archived view starts with the selected event's state (by default the latest
live serve), and its interactions remain local to that page. It does not poll
the working file or write to the working canvas's saved state. This preserves
initial state, not a recording of every interaction. Page bundle URLs identify
the source version and in-memory SDK generation so concurrent source/SDK edits
cannot mix the page and bundle. If an old SDK generation has been evicted from
memory, its bundle request asks for a page reload instead of serving different code.

Restore saves the current working source first—even an invalid, unserved draft—
then writes the selected source and appends a new revision linked to the original.
It keeps later history and the working canvas's `.canvas.data.json` state.
Restore uses an atomic file replacement and an optimistic source check; if an
edit is detected after the preservation snapshot it stops and leaves that edit
untouched. Symlinked source files are rejected for serving and restoration.
Typecheck diagnostics are returned after restoration. File replacement and SQLite
are separate operations: the original working source is durably archived before
replacement; an interrupted restore may be captured on the next successful serve.

The database survives pane closure and lives at:

- macOS: `~/Library/Application Support/herdr-canvas/history.sqlite`
- Linux: `$XDG_DATA_HOME/herdr-canvas/history.sqlite`, defaulting to
  `~/.local/share/herdr-canvas/history.sqlite`

Override with `HERDR_CANVAS_HISTORY_DB` or `--history-db PATH`. All commands also
accept `--dir PATH` to select a canvases directory. Artifact IDs are stable within
that directory and name; renames or different worktrees are separate artifacts.
SQLite uses WAL mode with a busy timeout for concurrent panes. History is retained
without automatic pruning; it may contain embedded data and saved UI state.
For backups, use SQLite's backup facilities rather than copying an active database
file without its WAL.

## Web gallery

```bash
bun run src/cli.ts web --port 4784
```

Open `http://127.0.0.1:4784` to search working canvases and archived versions,
preview one at a time, inspect raw source, or download a `.canvas.tsx` file.
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

```bash
bun run test
bun run test:e2e
bun run test:mcp-ui
bun run typecheck
```

`bun run test` is the unit/service suite. `bun run test:e2e` builds a Docker image
with real Herdr and Terminal Browser, starts Herdr on a PTY, verifies
that the pane is owned by `herdr.canvas`, and proves its server stops when the
pane closes.

GitHub Actions runs the typecheck and unit/service suite with Bun 1.4.0.
The root Dockerfile is an integration-test environment, not a production image.
`bun run test:mcp-ui` exercises the real canvas in Chromium with an MCP Apps host.
Install its browser first with `bun x playwright install chromium`. CI runs this
browser suite as well as the unit/service suite.

## Trust boundary

This is a local tool, not an authenticated multi-user service. Keep the web
server on loopback; do not expose it through a public proxy. Source checks reject
unsupported imports and APIs, but they are not a general-purpose security sandbox
for hostile JavaScript. Gallery previews run in isolated browser frames. Inline
canvases execute inside the chat host's MCP Apps sandbox; use trusted local canvas
source, as for the other local views. Artifact
source and saved state can contain private data; keep the history database private.
