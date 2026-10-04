# Run Artifacts in Docker

Run the full Artifacts application in a container, with apps and data stored in
a persistent volume. The image supports Linux amd64 and arm64; no Bun installation
is required on the host.

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

## Configure network access

The default command runs single-machine `celld dev` with authentication disabled,
so the example publishes the port on loopback only. For network access, configure
[authentication](authentication.md#configure-celld) in a custom Wrangler
config and mount it at `/app/wrangler.jsonc` (read-only), keeping the image's
`main` and assets paths. Set `ENVIRONMENT` to `production`; environment variables
passed with `docker -e` do not replace Wrangler `vars`. For bucket-backed nodes,
follow the [celld deployment guide](celld-deployment.md). Arguments after the
image name are passed directly to celld; for example, `--help` lists commands.

## Build and publish the image

The image runs celld directly, with native esbuild included. Bun is used only
during the build. The final distroless image has no Bun, Node, shell, package
manager, or `node_modules` directory and runs as UID/GID 65532.

For maintainers working from a source checkout:

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
