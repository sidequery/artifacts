# syntax=docker/dockerfile:1
FROM oven/bun:1.4.0 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:cloudflare --minify && bun run scripts/prepare-container.ts \
    && find dist/worker-app -name '*.map' -delete \
    && mkdir -p /state

FROM gcr.io/distroless/cc-debian13:nonroot AS runtime
LABEL org.opencontainers.image.source="https://github.com/sidequery/artifacts" \
      org.opencontainers.image.description="Sidequery Artifacts with celld" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=65532:65532 /state/ /app/.celld/
COPY --from=build /src/dist/container/bin/ /usr/local/bin/
COPY --from=build /src/dist/worker-app/ /app/dist/worker-app/
COPY --from=build /src/dist/cloudflare/assets/ /app/dist/cloudflare/assets/
COPY --from=build /src/dist/container/wrangler.jsonc /app/wrangler.jsonc
ENV CELLD_ESBUILD=/usr/local/bin/esbuild CELLD_IDLE_EVICT_S=60
WORKDIR /app
USER 65532:65532
VOLUME ["/app/.celld"]
EXPOSE 4786
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/celld"]
CMD ["dev", "/app", "--host", "0.0.0.0", "--port", "4786", "--no-watch", "--logs"]
