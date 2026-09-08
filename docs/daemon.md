# Local Artifacts server

The native Artifacts server is optional. It runs the packaged Worker and its
SQLite/KV state through a pinned celld runtime on `127.0.0.1`. The ordinary
Artifacts CLI, stdio MCP server, local gallery, and artifact commands do not start
or download celld.

## Foreground server

Run the server in the current terminal:

```sh
artifacts server
```

The default address is `http://127.0.0.1:4786`. `--port` selects another port.
The server keeps its project and native state under the Artifacts data directory;
`--state-dir PATH` overrides that project directory for a foreground run. Press
Ctrl-C to request a graceful stop. SIGTERM uses the same shutdown path.

On first use, Artifacts downloads celld 0.4.1 for a supported platform, verifies
the pinned archive and executable SHA-256 values, and installs it in the Artifact
data directory with user-only permissions. This release supports Apple Silicon
macOS and glibc Linux on arm64 or x64. The ordinary Bun commands do not require this native runtime; `artifacts server`
reports an explicit error when the native platform is unsupported.

## Background service

Use the operating system's user service manager for crash recovery:

```sh
artifacts server start
artifacts server status
artifacts server logs
artifacts server stop
```

`start` uses launchd on macOS and `systemd --user` on Linux. It first verifies
the packaged server assets and managed celld executable, then registers the
service and waits for owned-process readiness. A manual start does not enable
the service for future logins. `stop` unloads or stops the current job and waits
for graceful shutdown. It retains the server project and all SQLite/KV data.

`status` reports the service manager and four separate facts:

- `installedAtLogin`: the user explicitly enabled future login starts.
- `loaded`: the service definition is currently known to the manager.
- `running`: the manager reports a live main process.
- `ready`: that process published matching PID, port, and state-directory
  readiness, and its loopback health endpoint responds successfully.

The URL appears only when `ready` is true, so an unrelated process on the same
port cannot be reported as this Artifacts service. Service identities include a
stable hash of `ARTIFACTS_DATA_HOME`, which prevents commands for one data root
from stopping the service for another. Two roots still cannot listen on the
same port; `start` checks for that conflict before registration.

`logs` prints the most recent 100 lines from the service log. Select between 1
and 1000 lines with `artifacts server logs --lines N`. Each read is capped at 256
KiB even when the log is larger.

## Start at login

If the server is already running, stop it first. Then start it and opt in to
future login starts:

```sh
artifacts server start --at-login
```

Install `@sidequery/artifacts` globally before enabling this option, for example
with `bun add --global @sidequery/artifacts`. The supervisor definition records
the exact Bun executable and absolute installed `src/cli.ts` path. Do not create
a login service from `bunx` or another transient package cache: cleanup or cache
rotation can remove that recorded path.

`artifacts server stop` stops the current process but preserves the login setting,
so the service starts at the next login. Disable login startup, stop the service,
and remove its installed supervisor definition with:

```sh
artifacts server uninstall
```

Run `uninstall` before moving or removing the global package. Enabling login is
never part of package installation, upgrade, or publication.

## Data and configuration

Set `ARTIFACTS_DATA_HOME` to choose a data root. Otherwise Artifacts uses:

- macOS: `~/Library/Application Support/sidequery-artifacts`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/sidequery-artifacts`

The durable native project is under `server`, the managed runtime is under
`runtimes`, and lifecycle state and logs are under `daemon`. On Linux,
`XDG_CONFIG_HOME` selects the systemd user-unit directory when set.

Supervisor definitions forward `ARTIFACTS_DATA_HOME` and, for standalone binaries,
the embedded interpreter/runtime settings. They do not copy the invoking shell's
credentials or other environment variables. The native server binds only to
loopback. Its state is local application data and is not uploaded or backed up
automatically.

## Private Tailscale host (macOS)

`artifacts host` installs one persistent, single-owner Canvas host as a user launch
agent. It starts when that macOS user logs in, requires no sudo, and keeps its
SQLite state outside the installed package. Tailscale must already be installed
and signed in. Use the machine's HTTPS Tailscale origin and your exact Tailscale
login:

```sh
artifacts host install --origin https://your-machine.your-tailnet.ts.net \
  --tailscale-login you@example.com --serve
artifacts host status
```

The normal host provides the Canvas gallery without GitHub. To include the
optional runner status canvas and collector, authenticate the installed `gh` CLI
with access to the organization runners and selected repositories, then install:

```sh
artifacts host install --origin https://your-machine.your-tailnet.ts.net \
  --tailscale-login you@example.com --serve \
  --runner-org your-org --runner-repos your-org/repo-one,your-org/repo-two
```

Use `--gh-path /absolute/path/to/gh` if necessary. Credentials are obtained through
`gh` at service startup and written to the private runtime configuration; they
are never printed. The collector and plugin are shipped prebuilt. The initial
runner canvas is seeded once; restarts preserve edits, links and revision history.

`--serve` explicitly configures Tailscale Serve's HTTPS 443 proxy to
`http://127.0.0.1:4789`. Without it, routing is unchanged and must be configured
separately. Existing Serve configuration causes installation to stop before any
writes; inspect `tailscale serve status` and use `--replace-serve` only when you
intend to replace the HTTPS 443 route. Funnel must be disabled. The gateway
accepts only the configured origin and exact Tailscale identity. Both it and the
celld runtime (port 4788) listen on loopback; local processes are trusted. This is
one private library for one owner, not a multi-user authentication system.

```sh
artifacts host stop
artifacts host start
artifacts host logs --lines 100
artifacts host backup
artifacts host uninstall
```

The default data directory is `~/Library/Application Support/sidequery-canvas/host`.
Set `CANVAS_DATA_HOME` to choose its parent, or use `--data-dir PATH` consistently
on all host commands. One host launch agent is supported per macOS user. Stop
unloads the current service; it remains configured to start at the next login.
Uninstall removes the login service and preserves application data, logs, backups
and Tailscale routing. `artifacts host start` re-enables the retained installation.
Backups briefly stop the service, acquire the shared runtime
lock, archive the complete state, and restart only if it was previously loaded.
These archives can contain credentials and are private same-disk recovery copies;
copy them off-host for disaster recovery.

The installed service uses a durable copy of its prebuilt worker, assets and native
executables under `server/app/release`. Source checkouts must run
`bun run build:package` before installation. Package installations use the installed
Bun executable and the version-pinned celld download; no build runs at login.

The root URL always opens the gallery, including on a runner-enabled host. Open
`/runner-status/runners` for the runner dashboard.

A standalone distribution is built with `bun run build:executable`. It produces a
single Bun-compiled executable containing the package, production dependencies,
prebuilt worker/assets and native celld/esbuild binaries. On the destination Mac,
run that executable's `host install` command; Bun and package installation are not
required. Its payload is extracted once into the application data directory, and
host installation copies the executable and runtime into the durable host release
so removing the downloaded original does not break login startup. Tailscale (and
`gh` for the optional runner collector) are external prerequisites.

Add `--keep-warm` to `host install` to disable the host runtime's 60-second timed
idle-cell eviction and reduce reload latency after idle periods. The setting is
saved in `host.json` and survives restarts. It applies to the whole hosted runtime;
no synthetic requests or polling timers are used. Cells can still leave memory
under memory pressure or at the residency cap, so this is not an absolute memory
pin. Omitting the option preserves the 60-second default.

For selective warming, use `--warm-gallery --warm-canvases runner-status` during
installation. These settings keep the shared gallery library and named canvas
rendering objects active using sequential management GETs every 30 seconds:
`/api/gallery` and `/gallery/preview?name=NAME`. They do not visit arbitrary artifact
slugs, execute scripts, or invoke unrelated canvas backends. Reads time out after
25 seconds, never overlap, and abort when the service stops. Repeated identical
failures are logged once until the result changes. Other objects retain the normal
60-second idle eviction; do not add `--keep-warm` when only selected apps should
stay warm. Memory pressure and residency limits still apply.
