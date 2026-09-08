# Inline artifacts in chat

The HTTP server and workspace stdio server both provide MCP Apps views. Connect either transport as described in the [README](../README.md#connect-your-agent). Clients with MCP Apps support render interactive artifacts; other clients receive tool results and diagnostics. Use the server gallery to view HTTP-server artifacts in a browser.

## Creating and viewing

Ask the agent to create an artifact: a successful `artifact_write` displays the actual React
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
compact. Workspace stdio previews need no web server, external asset hosting or Herdr installation.
Clients without MCP Apps support receive the normal text/diagnostic results;
they cannot display the interactive artifact.

## Workspace preview state and host actions

The details below describe filesystem/stdio previews. The HTTP server retains compiled revisions; see the [source map](architecture.md#hosted-services).

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
