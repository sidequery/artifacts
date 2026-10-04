# Artifacts documentation

Artifacts lets you build apps, APIs, and automations with a coding agent and
manage them in a browser. Start locally with `bunx @sidequery/artifacts host`,
then open [localhost:4786](http://127.0.0.1:4786).

## Start using Artifacts

| I want to… | Guide |
| --- | --- |
| Run Artifacts on my machine | [Local host](daemon.md) or [Docker](docker.md) |
| Sign in and connect my coding agent | [Authentication and MCP](authentication.md#connect-to-an-existing-deployment) |
| Share with my team or publish a link | [Libraries and URL permissions](authentication.md#library-and-url-permissions) |
| Work with source files in a local project | [File-based workspace](local-workspace.md) |

## Build something

Ask your agent to read `artifact_guide` for a React app or `script_guide` for an
API, webhook, or scheduled job. These tools describe the APIs available in your
running installation.

| I need… | Guide |
| --- | --- |
| An API, webhook, or scheduled job | [Scripts](scripts.md) |
| A React app with a database or server-side secrets | [App backends and SQLite](app-backends.md) |
| File uploads and downloads | [File storage](files.md) |
| Multiple pages or HTTP API routes | [Routing](routing.md) |
| To copy a project to another installation | [Export and import](project-portability.md) |
| Native queues, KV, R2, D1, or Durable Objects | [Native Worker apps](native-workers.md) |

## Run Artifacts for a team

Choose [Cloudflare](cloudflare.md) or [your own servers with celld](celld-deployment.md).
Connect the sign-in service your team already uses, such as Google, Microsoft
Entra ID, or Okta. Artifacts' built-in authentication library, Better Auth,
supports a broad range of OAuth/OIDC providers. Cloudflare Access is an alternative
for Cloudflare deployments. The [authentication guide](authentication.md)
explains provider compatibility, setup, and how to admit users.

Administrators can also install [shared packages and server functions](runtime-plugins.md)
or configure a [local native Worker operator](native-worker-operator.md).

## Contribute and maintain

See the [source map](architecture.md), [development commands](../README.md#development),
and [release guide](releasing.md). The [native Worker prototype](native-worker-prototype.md)
is a development reference; use the managed native Worker guide to deploy apps.
