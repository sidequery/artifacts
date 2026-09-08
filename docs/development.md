# Development

## Run from source

From the checkout:

```bash
bun install --frozen-lockfile
bun run artifacts write overview --file examples/overview.artifact.tsx
bun run artifacts web --port 4784
```

Open `http://127.0.0.1:4784`. Your working artifacts and UI state are ignored by
this repository; reusable checked-in samples belong in `examples/`.
`bun run artifacts` uses the same CLI directly from this checkout.

To run the native HTTP server from this checkout, build its packaged assets first:

```bash
bun run build:package
bun run artifacts server
```

## Checks

See the [source map](architecture.md) for runtime boundaries, MCP modules,
hosted services, and Herdr action entrypoints.

```bash
bun run test
bun run test:e2e
bun run test:mcp-ui
bun run test:package
bun run typecheck
```

`bun run test` is the unit/service suite. `bun run test:e2e` builds a Docker image
with real Herdr and Terminal Browser, starts Herdr on a PTY, verifies
that the pane is owned by `herdr.artifacts`, and proves its server stops when the
pane closes.

GitHub Actions runs the typecheck and unit/service suite with Bun 1.4.0.
The root Dockerfile is an integration-test environment, not a production image.
`bun run test:mcp-ui` exercises the real artifact in Chromium with an MCP Apps host.
Install its browser first with `bun x playwright install chromium`. CI runs this
browser suite, the unit/service suite, and a clean tarball install that exercises
the installed CLI, gallery, compilation, and stdio MCP server.
