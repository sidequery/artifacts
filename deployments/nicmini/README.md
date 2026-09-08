# nicmini deployment tooling

This optional source-checkout tool manages the macOS launchd service and
Tailscale gateway used on nicmini. Core packages and standalone executables
exclude this directory, the gateway, backup implementation, and runner deployment
assets. The core `artifacts host` command is a separate, network-independent
local service manager for macOS and Linux.

## Prepare and install

Install Bun dependencies in the checkout, then prepare deployment assets:

```sh
bun install --frozen-lockfile
bun run deployments/nicmini/build.ts
bun deployments/nicmini/cli.ts install \
  --origin https://your-machine.your-tailnet.ts.net \
  --tailscale-login you@example.com --serve
```

This tool requires macOS, Bun, and an installed, authenticated Tailscale client.
It copies the prepared app and native celld/esbuild into its data directory.
The service uses the installed Bun executable and starts at user login.
Removing the source checkout does not remove installed service assets.

The root URL opens the gallery. To include runner-status, authenticate `gh` and
add `--runner-org ORG --runner-repos ORG/REPO,...` at installation. The collector
obtains credentials through `gh` at startup without printing them. It seeds the
runner artifact once and preserves subsequent edits and revision history.
The dashboard is at `/runner-status/runners`.

`--serve` configures the HTTPS 443 proxy to loopback port 4789. Without it, the
operator configures routing separately. Existing Serve configuration is rejected
unless `--replace-serve` explicitly authorizes replacing that route. Funnel must
be disabled. The gateway admits one exact Tailscale login and origin; it and celld
(port 4788) listen on loopback. Local OS processes are inside this trust boundary.

## Lifecycle and state

```sh
bun deployments/nicmini/cli.ts status
bun deployments/nicmini/cli.ts logs --lines 100
bun deployments/nicmini/cli.ts stop
bun deployments/nicmini/cli.ts start
bun deployments/nicmini/cli.ts backup
bun deployments/nicmini/cli.ts uninstall
```

Use `--data-dir PATH` consistently for an existing installation. nicmini's data
is at `/Users/nico/Library/Application Support/sidequery-canvas-host`; preserve
that directory and its `server/.celld/dev` state. Never run a second installer
against it. A fresh installation defaults to the Artifacts data root plus `/host`
(with the core legacy-data-root fallback). One deployment launch agent is
supported per macOS user.

Stop unloads the running job but retains login configuration. Uninstall removes
the login service and retains app state, logs, backups, and Tailscale routing.
Backup stops the service, locks quiesced state, writes a local `.tar.gz`, and
restarts only if it was previously loaded. Archives have private file permissions
but are not encrypted and can contain credentials. They are same-disk copies;
off-host recovery requires a separate copy.

Use `--warm-gallery --warm-canvases runner-status` to issue bounded sequential
management reads every 30 seconds. Other objects retain the normal 60-second
idle eviction. `--keep-warm` instead disables timed eviction for the entire
runtime, so omit it for selective warming. Memory pressure can still evict cells.

The core's standalone executable does not install this deployment. Building it
neither includes these assets nor configures Tailscale.
