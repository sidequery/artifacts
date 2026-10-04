# Sidequery Artifacts

Build and share small apps, APIs, and automations on infrastructure you control.

Create interactive React apps and TypeScript scripts with persistent SQLite
storage, file uploads, secrets, and scheduled runs. Build with your coding agent
through MCP, then manage source, versions, and execution in the browser.

Deploy on **Cloudflare** or run your own servers with **celld**. Keep tools private,
share them with your team, or publish a public URL.

## What you can build

- **Apps and dashboards:** React interfaces with their own TypeScript backend,
  SQLite database, and file storage.
- **APIs and webhooks:** TypeScript HTTP handlers with outbound requests,
  per-script secrets, and persistent SQLite storage.
- **Automations:** run scripts or app backends on an interval or cron schedule,
  with pause/resume, manual runs, and execution history.
- **Tools to share:** give apps and scripts readable URLs, choose private or
  public access, and organize them in personal or team libraries.

Projects support helper files and pinned bun dependencies. Edit and restore
source revisions, or remix an existing project into a new one with fresh data.
Source restores preserve the current database and files; they do not roll back
live data.

## Get started

Install [Bun](https://bun.sh/) 1.4.0 or newer, then start the full application locally:

```sh
bunx @sidequery/artifacts host
```

Open [localhost:4786](http://127.0.0.1:4786) for the gallery. Connect your agent to
the HTTP MCP endpoint at `http://127.0.0.1:4786/mcp` to create apps and scripts.
The server runs in the foreground; Ctrl-C stops it.

The first run downloads and verifies a pinned celld binary. Apps and runtime data
persist on your machine. The bundled runtime supports Apple Silicon macOS and
glibc Linux on arm64 or x64.

For a persistent installation and a background service:

```sh
bun add --global @sidequery/artifacts
artifacts host start
artifacts host status
```

Use `artifacts host install` to enable startup at login. See the
[host guide](docs/daemon.md) for lifecycle commands, data locations, and upgrades.

## Deploy

### Docker

The image at `ghcr.io/sidequery/artifacts:latest` supports Linux amd64 and arm64.
It runs celld directly, with the application and native esbuild already included.
Bun is used only during the build. The final distroless image has no Bun, Node,
shell, package manager, or `node_modules` directory and runs as UID/GID 65532.

```sh
docker run -d --name artifacts --restart unless-stopped \
  --stop-timeout 60 \
  -p 127.0.0.1:4786:4786 \
  -v artifacts-data:/app/.celld \
  ghcr.io/sidequery/artifacts:latest
```

Open [localhost:4786](http://127.0.0.1:4786); the MCP endpoint is
`http://127.0.0.1:4786/mcp`. The named volume preserves apps, databases, files,
and schedules across container replacements. Stop the container before backing
up the volume. Allow 60 seconds for graceful shutdown.

The default command runs single-machine `celld dev` with authentication disabled,
so the example publishes the port on loopback only. For network access, configure
[authentication](docs/authentication.md#configure-celld) in a custom Wrangler
config and mount it at `/app/wrangler.jsonc` (read-only), keeping the image's
`main` and assets paths. Set `ENVIRONMENT` to `production`; environment variables
passed with `docker -e` do not replace Wrangler `vars`. For bucket-backed nodes,
follow the [celld deployment guide](docs/celld-deployment.md). Arguments after the
image name are passed directly to celld; for example, `--help` lists commands.

Build and test locally:

```sh
docker build -t artifacts:local .
bun install --frozen-lockfile
ARTIFACTS_DOCKER_IMAGE=artifacts:local bun test scripts/docker.integration.test.ts
```

CI builds and tests both image architectures on pushes and pull requests. Image
publishing waits for the application, executable, and Docker checks to pass. Pushes
to `main` publish `latest` and `sha-<full-commit>`; `v*` tags publish the matching
tag and commit tag. Pin a commit tag or image digest for repeatable deployments.
The package is public; CI checks anonymous access and fails if the
image is private. When publishing under a different package name, a package
administrator must set its visibility to **Public** in GitHub package settings
after the first push.

### Cloudflare and celld fleets

Configure sign-in before using a network deployment. The
[authentication guide](docs/authentication.md) covers provider setup, Cloudflare
Access, MCP OAuth, and troubleshooting. The default local host needs no sign-in.

Both deployment options run the Artifacts application, including the gallery,
HTTP MCP server, app backends, scripts, storage, and schedules. You own the
infrastructure and configure who can sign in.

| | Cloudflare | Your own servers with celld |
| --- | --- | --- |
| Run on | Cloudflare Workers and Durable Objects | Machines running celld nodes backed by a supported object store |
| Operations | Cloudflare manages the runtime | You manage nodes, TLS, storage, and rollouts |
| Setup | [Cloudflare deployment](docs/cloudflare.md) | [celld deployment](docs/celld-deployment.md) |

Cloudflare deployment requires Workers Paid. Production CPU/memory qualification
is still outstanding; see the deployment guide for current limits.

The local `host` command binds to loopback and uses local development state.
For a network deployment, follow the celld guide to configure production nodes
and authentication. The local host command does not provision a fleet or migrate
its data to one.

Deployments support Cloudflare Access or configurable provider sign-in through
Better Auth. Personal libraries are private to their owner; admitted team members
can read and edit the team library. Public links are configured separately from
library ownership. See [authentication and access](docs/authentication.md)
and [link access](docs/scripts.md#access).

## Build with your agent

Add your deployment's HTTP MCP URL to your client:

```text
https://your-artifacts-host/mcp
```

For the local host, use `http://127.0.0.1:4786/mcp`. Remote clients use the
configured deployment's sign-in flow. Optional `workspace` and `library` query
parameters select a workspace or the team library.

Ask your agent to read `artifact_guide` for React apps or `script_guide` for
TypeScript scripts before authoring. For example:

> Build a team lunch poll with a React UI and a SQLite backend.

> Create a webhook that verifies a signature using a stored secret and saves
> incoming events to SQLite.

> Make a script that checks an endpoint every hour and records the result.

For sign-in steps, supported credentials, and connection failures, see
[Connect to an existing deployment](docs/authentication.md#connect-to-an-existing-deployment).

The tools support source reads and edits, typechecking, history, restore, remix,
and execution. MCP Apps clients can also display interactive React artifacts
inside the conversation. Clients without MCP Apps support still receive tool
results and diagnostics.

## Local files and terminal workflows

For React artifacts stored alongside your work, use the file-based CLI and gallery:

```sh
artifacts write overview --file overview.artifact.tsx
artifacts typecheck overview
artifacts web --port 4784
```

This workspace mode supports local source files, history, and stdio MCP. It does
not execute scripts, app backends, or schedules, and it does not synchronize with
the full host. Herdr is optional for opening artifacts beside a terminal agent.
See the [local workspace and MCP reference](docs/local-workspace.md) for setup,
inline views, targeted edits, history, and compatibility with older Canvas sources.

## Documentation

- [Authentication, MCP sign-in, and access permissions](docs/authentication.md)
- [Host commands and local persistence](docs/daemon.md)
- [Deploy to Cloudflare](docs/cloudflare.md)
- [Deploy celld on your own infrastructure](docs/celld-deployment.md)
- [Scripts, URLs, dependencies, remix, and schedules](docs/scripts.md)
- [Native Worker apps, manifests, providers, and recovery](docs/native-workers.md)
- [Complete project export and import](docs/project-portability.md)
- [App backends and SQLite](docs/cloudflare.md#native-artifact-servers-and-storage)
- [File storage](docs/files.md)
- [Client-side routing](docs/routing.md)
- [Runtime plugins](docs/runtime-plugins.md)
- [Local workspace, CLI, and MCP reference](docs/local-workspace.md)
- [Source map](docs/architecture.md) and [release process](docs/releasing.md)

## Development

Preview the gallery with an isolated sample library:

```sh
bun install --frozen-lockfile
bun run demo
```

Open [localhost:4788](http://127.0.0.1:4788). Each launch creates temporary
sample files and history, separate from your existing library. Set `DEMO_PORT`
to use another port. Stop with Ctrl-C.

```sh
bun install --frozen-lockfile
bun run dev:cloudflare
```

This starts the application under local workerd at
[localhost:4785](http://127.0.0.1:4785). To develop against celld instead, use
`bun run dev:celld` with celld on your `PATH`; see the
[runtime setup](docs/cloudflare.md#optional-celld-compatibility).

```sh
bun run typecheck
bun run test
bun run typecheck:cloudflare
bun run test:cloudflare
```

Browser tests require `bun x playwright install chromium`. Additional suites cover
[MCP Apps and Herdr](docs/local-workspace.md#development-checks), celld
(`bun run test:celld`), and package installation (`bun run test:package`).
`e2e/Dockerfile` is the Herdr integration-test environment; the root Dockerfile
builds the standalone celld image.
