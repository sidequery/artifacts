# Releasing @sidequery/artifacts

Artifacts requires Bun 1.4 or newer. The bun package includes the CLI, its source
assets used by Bun at runtime, and the prebuilt Worker/assets used by the optional
local celld server. Consumers do not need Wrangler or a source checkout.

## GitHub Actions releases

The `Publish npm package` workflow (`.github/workflows/publish.yml`) uses npm
trusted publishing (OIDC). It runs only when manually dispatched on `main` in
`sidequery/artifacts`; merging a PR does not publish. Enter the exact `package.json`
version when dispatching. The workflow checks types and source tests, builds one
tarball, exercises that archive in an isolated consumer including native server
persistence, then publishes the same archive from a separate GitHub-hosted job.
Only the publish job can request an OIDC token. Bun handles installation, builds,
and tests; Node 24's npm CLI handles the OIDC publish exchange. No registry token
is stored in GitHub or 1Password for routine releases.

### One-time npm setup

The package must first exist on npm before its trusted publisher can be configured.
For the first approved release, use the local validation and publication steps
below with interactive npm authentication (or a temporary bootstrap credential).
Then configure the trusted publisher with the npm CLI (11.17 or newer):

```bash
npm trust github @sidequery/artifacts --repo sidequery/artifacts --file publish.yml --allow-publish
```

The equivalent settings on the npm package page are:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `sidequery` |
| Repository | `artifacts` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Allowed actions | Enable direct `npm publish` |

After a successful OIDC release, set package publishing access to **Require
two-factor authentication and disallow tokens** and revoke any temporary bootstrap
token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
Saving the configuration alone does not validate it; the first successful OIDC
publication verifies the connection. Subsequent releases need a new package version.

## Local validation and first publication

1. Update `version` in `package.json` and refresh `bun.lock` with `bun install`.
2. Run `bun run typecheck`, `bun run typecheck:cloudflare`, and `bun test src`.
3. Run `bun run test:package`. This builds the Worker and installs the actual
   tarball into a separate consumer directory before exercising the CLI, gallery,
   and MCP.
4. Run the native package check on a supported platform:
   `CELLD_PACKAGE_INTEGRATION=1 bun run test:package`.
5. Run `bun pm pack --destination /tmp` to build a release tarball. Test that exact
   archive with `ARTIFACTS_PACKAGE_ARCHIVE=/tmp/sidequery-artifacts-VERSION.tgz
   CELLD_PACKAGE_INTEGRATION=1 bun test scripts/package.integration.test.ts --timeout 360000`.
6. After release approval and authentication for the `@sidequery` scope,
   publish that tarball with `npm publish /tmp/sidequery-artifacts-VERSION.tgz --access public --ignore-scripts`.

A package build is not a registry publication. CI validates packaging without
publishing. Never enable a login daemon as an install or publish lifecycle script.
The user enables it explicitly through the [daemon commands](daemon.md).

## celld upgrades

The managed runtime is pinned in `src/local/celld-runtime.ts`. For an upgrade, obtain the
archive SHA-256 values from the upstream release, verify each platform archive,
and compute the decompressed executable hashes before updating the manifest.
Do not select `latest` dynamically. The cache is keyed by celld version and target;
existing servers keep their persistent data separately from executable versions.

Qualify `bun run test:celld` and the installed native package check before changing
the pin. Include cold start, stored SQL/KV across restart, OAuth compatibility in
the runtime suite, and daemon lifecycle on supported service managers. The local
packaged server uses loopback single-user mode; deploying Better Auth remains the
separate configuration described in [Cloudflare setup](cloudflare.md).

celld v0.4.1 publishes Apple Silicon macOS and glibc Linux arm64/x64 binaries.
Intel macOS and other targets cannot use this managed native server version.
The ordinary Bun CLI, stdio MCP, and local file gallery do not download celld.

## Standalone executables

`bun run build:executable` builds a native `dist/binaries/artifacts-PLATFORM-ARCH`
executable and SHA-256 file on the current supported machine. It embeds the Bun
runtime, the prepared package, locked production dependencies, celld, and native
esbuild. Users need no separate Bun, Node, dependency install, or source checkout.
The executable extracts a versioned runtime tree under the Artifacts data directory;
saved artifacts and server state are separate from that tree.

CI builds and tests native macOS arm64 and Linux glibc arm64/x64 artifacts.
The executable uses the existing platform-neutral CLI and local server commands;
it contains no Tailscale gateway or deployment installer. A binary build does not publish a release. CI artifacts contain the executable and checksum.
Run `bun test scripts/executable.integration.test.ts --timeout 180000` against a
built executable to exercise its CLI, local compiler, and stdio MCP with no Bun on
PATH. Set `ARTIFACTS_EXECUTABLE` to test a specific artifact.
