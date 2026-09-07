# Releasing @sidequery/canvas

Canvas requires Bun 1.4 or newer. The bun package includes the CLI, its source
assets used by Bun at runtime, and the prebuilt Worker/assets used by the optional
local celld server. Consumers do not need Wrangler or a source checkout.

1. Update `version` in `package.json` and refresh `bun.lock` with `bun install`.
2. Run `bun run typecheck`, `bun run typecheck:cloudflare`, and `bun test src`.
3. Run `bun run test:package`. This builds the Worker and installs the actual
   tarball into a separate consumer directory before exercising the CLI, gallery,
   and MCP.
4. Run the native package check on a supported platform:
   `CELLD_PACKAGE_INTEGRATION=1 bun run test:package`.
5. Run `bun pm pack --destination /tmp` to build a release tarball. Inspect the
   contents and retain the exact tested tarball for the release.
6. After release approval and bun authentication for the `@sidequery` scope,
   publish that tarball with `bun publish /tmp/sidequery-canvas-VERSION.tgz --access public`.

A package build is not a registry publication. CI validates packaging without
publishing. Never enable a login daemon as an install or publish lifecycle script.
The user enables it explicitly through the [daemon commands](daemon.md).

## celld upgrades

The managed runtime is pinned in `src/celldRuntime.ts`. For an upgrade, obtain the
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
