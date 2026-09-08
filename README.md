# Sidequery Artifacts

Build interactive React apps with your agent, browse them in a gallery, and keep
their source and version history. Artifacts can include a backend, SQLite data,
and uploaded files. Agents create and edit them through MCP; clients that support
MCP Apps can display them directly in chat.

Use it for dashboards, small tools with persistent data, HTTP handlers, or
scheduled jobs. Run locally, or deploy to your own Cloudflare account for remote
access and sharing.

<img width="1417" height="945" alt="Sidequery Artifacts gallery with an interactive artifact preview" src="https://github.com/user-attachments/assets/87b51b80-660d-449a-8e80-acbeb5db15e9" />

## Quick start

With **Bun 1.4.0+** installed, run:

```bash
bunx @sidequery/artifacts server
```

Or use `npx` with Bun installed and on your `PATH`:

```bash
npx --yes @sidequery/artifacts server
```

Open [the gallery](http://127.0.0.1:4786). No source checkout or global package
installation is needed.

The first run downloads the native runtime. Supported platforms are Apple Silicon
macOS and glibc Linux on arm64 or x64. Keep this terminal running while you use the
server; Ctrl-C stops it. Your artifacts and data survive restarts.

## Connect your agent

Add an **HTTP MCP server** named `artifacts` with this URL:

```text
http://127.0.0.1:4786/mcp
```

For example, in Claude Code, run this from your project directory, then start a
new agent session:

```bash
claude mcp add --transport http artifacts http://127.0.0.1:4786/mcp
```

The agent must run on the same machine to reach this loopback address. For a
remote client, use a [hosted deployment](docs/cloudflare.md).

Ask your agent:

> Read artifact_guide, then create an artifact called “reading-list” where I can
> add books, mark them finished, and filter by status. Store the books in SQLite
> so they survive reloads. Show me the finished artifact.

The agent should create the UI and its backend. Open `reading-list` in the gallery
and add a book; reload it to see the saved data. In a client with MCP Apps support,
the agent can also show the interactive artifact inside the conversation.
Clients without that support can still create and edit artifacts.

## What you can build

- **Interactive apps:** React interfaces with charts, forms, tables, and controls,
  plus helper files and pinned package dependencies.
- **Apps with data:** per-artifact SQLite backends and file storage that persist
  across source edits. See [backends](docs/artifact-backends.md) and
  [files](docs/files.md).
- **HTTP scripts:** TypeScript request handlers with SQLite, secrets, and logs.
  Hosted URLs can serve webhooks or other integrations.
- **Scheduled work:** run artifact backends or scripts on intervals or cron
  schedules, and inspect their run history.
- **Reusable and shareable tools:** remix an existing artifact, browse source
  revisions, or give a hosted artifact a private or public URL.

Scripts, schedules, and URL controls are covered in the
[scripts and automation guide](docs/scripts.md). The local server runs the same
application as the Cloudflare deployment; its URLs remain local to your machine.

## Keep the server running

For a background service, install the CLI globally:

```bash
bun add --global @sidequery/artifacts
artifacts server start
artifacts server status
```

Stop any foreground server first. Use `artifacts server stop` to stop the service.
To enable startup at login, stop the service and restart it with
`artifacts server start --at-login`. A global installation gives the service a
stable executable path.

See [server management](docs/daemon.md) for logs, data locations, and disabling
login startup.

## Work with workspace files

If you want your agent to edit `.artifact.tsx` files in a project directory, use
the workspace stdio MCP server:

```json
{
  "command": "bunx",
  "args": ["@sidequery/artifacts", "mcp", "--dir", "/absolute/path/to/workspace/artifacts"]
}
```

Replace the path with your project's artifacts directory. This mode supports
source editing, typechecking, compilation, version history, and inline MCP Apps
previews. It requires Bun on Linux or macOS.

To browse those same files:

```bash
bunx @sidequery/artifacts web --dir /absolute/path/to/workspace/artifacts --port 4784
```

Open [the workspace gallery](http://127.0.0.1:4784).

| | HTTP server (`server`) | Workspace mode (`mcp` / `web`) |
| --- | --- | --- |
| Source storage | Managed application data | Files in your project directory |
| Agent connection | HTTP MCP | Stdio MCP |
| Backend code, SQLite app data, files, scripts, schedules | Supported | Not available |
| Source history and interactive previews | Supported | Supported |

The two modes have separate storage and do not synchronize automatically.
Agents without MCP can use the [workspace CLI](docs/workspace.md).
[Herdr](docs/herdr.md) is optional and only needed to open workspace artifacts
in terminal panes.

## Data and sharing

Local servers listen on `127.0.0.1` for use on your machine. They are not configured
for public access; use an authenticated [Cloudflare deployment](docs/cloudflare.md)
for remote users.

The HTTP server keeps data in the operating system's
[application-data directory](docs/daemon.md#data-and-configuration). Workspace mode
keeps source files in your chosen directory and a separate
[history database](docs/workspace.md#artifact-history). Neither mode automatically
uploads or backs up local data.

On hosted deployments, private links require the appropriate library access;
public links let other people view an artifact or invoke a script. Public artifact
files are readable through its link. **Restoring source does not roll back live
databases or uploaded files.**

## Documentation

- [Workspace CLI, source editing, and history](docs/workspace.md)
- [Inline artifacts and MCP Apps behavior](docs/mcp-apps.md)
- [Artifact backends and storage](docs/artifact-backends.md)
- [File storage](docs/files.md)
- [Scripts, direct URLs, remix, and schedules](docs/scripts.md)
- [Local server management](docs/daemon.md)
- [Cloudflare deployment and authentication](docs/cloudflare.md)
- [Herdr terminal integration](docs/herdr.md)
- [Development and checks](docs/development.md) · [Source map](docs/architecture.md)
