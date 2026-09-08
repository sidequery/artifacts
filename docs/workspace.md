# Workspace CLI and source reference

This document covers the filesystem CLI, stdio MCP server, and workspace gallery (`artifacts web`). The HTTP server (`artifacts server`) uses separate storage and execution.

Examples use the globally installed `artifacts` command. Substitute `bunx @sidequery/artifacts` to run without a global install. See the [quick start](../README.md#work-with-workspace-files) for setup.

## Agent workflow

Call `artifact_guide` before creating an artifact if you have not read it in the current
conversation. It covers the SDK contract, host APIs, restrictions, and validation.
Import standard React hooks from `sidequery/artifacts` for component state and effects.
Use `useArtifactState(key, defaultValue)` when you want host-backed state; persistence
depends on the view.

Artifacts live at `<workspace>/artifacts/<name>.artifact.tsx`. Import the SDK from
`sidequery/artifacts` (`herdr/canvas` and `cursor/canvas` remain compatibility aliases).
Projects can also import their declared helper files and pinned dependencies. The following commands assume you have authored `overview.artifact.tsx` in the current directory. `open` requires the optional [Herdr integration](herdr.md):

```bash
artifacts list
artifacts write overview --file overview.artifact.tsx
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

## Targeted reads and edits

### Projects and remix

CLI writes accept `--project PROJECT_JSON` for helper files and pinned package
dependencies. Read or edit a helper with `--source-file lib/helper.ts`.
Use `artifacts remix SOURCE NEW_NAME` to copy an artifact with source provenance
and fresh state. See [project contracts](scripts.md#third-party-dependencies)
for the project object shape.

### Source operations

Use `read` / `artifact_read` to retrieve only the needed working-source lines, and
`edit` / `artifact_edit` to change them without resending the whole artifact. These
operations share the same implementation across CLI and MCP. They accept an artifact
name (with optional `.artifact.tsx` suffix), not a path; symlinks are rejected.

```bash
artifacts read overview --start-line 5 --end-line 12
artifacts edit overview --stdin <<'JSON'
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
history revisions until successfully served. MCP writes display inline previews automatically; CLI uses separate
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
artifacts history                    # all artifacts in this workspace
artifacts history midnight-greenhouse
artifacts show VERSION_ID            # raw source, metadata, serve events
artifacts show VERSION_ID --source   # raw TSX on stdout
artifacts open --version VERSION_ID  # open an archived version in a pane
artifacts open --version VERSION_ID --event EVENT_ID
artifacts restore VERSION_ID         # restore source as a new revision
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
artifacts web --port 4784
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
