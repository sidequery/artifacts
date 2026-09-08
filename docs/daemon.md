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

Supervisor definitions forward only `ARTIFACTS_DATA_HOME`; they do not copy the
invoking shell's environment or credentials. The native server binds only to
loopback. Its state is local application data and is not uploaded or backed up
automatically.
