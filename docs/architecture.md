# Source map

Artifacts is one package with two execution paths. `artifacts web`, filesystem commands,
and stdio MCP use Bun with local artifact files and a history database. The hosted
application uses Workers and Durable Objects; it runs on Cloudflare or locally
through celld (`artifacts server`). Running the Worker application locally does not
turn it into the filesystem/stdio implementation.

| Location | Responsibility |
| --- | --- |
| `src/cli.ts` | Public CLI entrypoint, including the Herdr plugin's list/open actions |
| `src/service.ts`, `artifactFile.ts`, `history.ts`, `compile.ts`, `typecheck.ts` | Bun filesystem artifact operations |
| `src/local/` | Local process lifecycle: `preview-daemon.ts` reuses/starts a Bun preview server; `server-daemon.ts` manages the celld server through launchd/systemd; `server.ts` launches it; `celld-runtime.ts` supplies the pinned executable |
| `src/mcp/` | Shared MCP tool schemas (`tools.ts`), artifact guide (`guide.ts`), and app contract (`app-contract.ts`); Bun tool dispatch (`local-tools.ts`), stdio framing/transport (`protocol.ts`, `stdio.ts`), and app HTML/local preview assembly (`app.ts`) |
| `src/sdk/` | Public artifact authoring API, components, hooks, and native server helpers |
| `src/runtime/` | Browser entrypoints and bridges for Herdr, MCP Apps, and hosted artifacts |
| `src/gallery/`, `src/auth/` | Gallery and sign-in UI, plus their asset assembly/serving helpers |
| `src/httpTypes.ts`, `historyTypes.ts`, `diagnostics.ts`, `sandbox.ts` | Shared request/history contracts and source validation used by both execution paths |
| `cloudflare/` | Worker application, HTTP MCP, authentication, storage, compilation and execution; also packaged for celld |
| `scripts/` | Build, packaging, development and deployment utilities |
| `e2e/` | Browser, Herdr and packaged-runtime integration harnesses; unit/service tests stay beside their source |

## Hosted services

`cloudflare/worker.ts` connects authenticated requests to the application.
`mcp.ts` owns the HTTP MCP transport and `tool-contract.ts` specializes the shared
schemas for hosted capabilities. `service.ts` coordinates artifact operations,
artifact activation, artifact links, and the combined gallery. `script-service.ts`
owns script reads, mutations, execution, secrets and logs; `script-guide.ts`
contains its MCP authoring guidance. `artifact-service.ts` supplies the shared
library/workspace identity and URL metadata used by both services.

Storage and execution remain separate: `library.ts` and `scripts.ts` keep source
and revisions; `links.ts` owns slugs and active revision pointers; `backend.ts`
and `script-backend.ts` execute code. Code edits retain the validation and atomic
activation sequence before switching a working URL.

Successful artifact edits persist both compiled client and server code in the
library Durable Object before activating the revision. Each revision pins its
compiled artifact, including its SDK/browser libraries and compiler identity.
Gallery, standalone, MCP and backend reads load that artifact without invoking
the compiler. Source-only revisions from older installations require an explicit
`artifact_compile` backfill by name or version ID; source/history remain intact.

## Herdr integration

`herdr-plugin.toml` declares the pane and actions. An action specifies the command
Herdr runs; it does not need a separate source directory. Both list and open use
`src/cli.ts`. Open accepts an explicit artifact name or falls back to
`ARTIFACTS_NAME`; `--version` selects archived source without that fallback.
`src/herdr.ts` is the Herdr client, `src/open.ts` coordinates artifact opening, and
`src/viewer.ts` owns the pane lifecycle.

## Packaging

`package.json` lists shipped source files explicitly. When relocating a runtime
module, update that list and build-time references as well as imports. The clean
tarball integration test exercises the installed CLI, gallery, compiler and MCP
without a checkout, so it detects missing package files. Generated Worker assets
live in `dist/`; source imports under `cloudflare/` require those build outputs.
