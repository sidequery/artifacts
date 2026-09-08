/**
 * Single-owner gateway behind Tailscale Serve (never Funnel). Serve must replace
 * client-supplied Tailscale identity headers and preserve the public Host header.
 * Only the loopback listener is trusted: local OS processes can impersonate the
 * owner and are inside this deployment's trust boundary. Never bind it publicly.
 * All admitted requests use celld's ENVIRONMENT=local identity/private library;
 * this is deliberately not a multi-user authentication provider.
 */
export type TailnetGatewayConfig = {
  publicOrigin: string;
  upstreamOrigin: string;
  allowedLogin: string;
  port: number;
  landingPath?: string;
};

function exactOrigin(value: string, protocol: string): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || value !== url.origin || url.username || url.password) {
    throw new Error(`Expected an exact ${protocol} origin without a path`);
  }
  return url;
}

function validateConfig(config: TailnetGatewayConfig) {
  const publicUrl = exactOrigin(config.publicOrigin, "https:");
  const upstreamUrl = exactOrigin(config.upstreamOrigin, "http:");
  if (upstreamUrl.hostname !== "127.0.0.1") throw new Error("upstreamOrigin must use 127.0.0.1");
  if (typeof config.allowedLogin !== "string" || !config.allowedLogin || /[\s,\x00-\x1f\x7f]/.test(config.allowedLogin)) {
    throw new Error("allowedLogin must be one exact Tailscale login");
  }
  // Zero is useful for ephemeral integration-test listeners.
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid gateway port");
  if (config.landingPath !== undefined && (
    !config.landingPath.startsWith("/") || config.landingPath.startsWith("//") ||
    /[\\\x00-\x20\x7f]/.test(config.landingPath) ||
    new URL(config.landingPath, publicUrl).origin !== publicUrl.origin
  )) throw new Error("landingPath must be a same-origin absolute path");
  return { publicUrl, upstreamUrl };
}

const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function cleanHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of hopHeaders) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("tailscale-") || name.startsWith("cf-access-") || name.startsWith("x-forwarded-") ||
      ["forwarded", "x-real-ip", "cookie"].includes(name)) headers.delete(name);
  }
  return headers;
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });
}

/** Mount only on a trusted loopback transport; prefer startTailnetGateway. */
export function createTailnetGatewayHandler(config: TailnetGatewayConfig): (request: Request) => Promise<Response> {
  const { publicUrl, upstreamUrl } = validateConfig(config);
  const { allowedLogin, landingPath } = config;
  return async request => {
    const url = new URL(request.url);
    if (request.headers.get("host") !== publicUrl.host || url.host !== publicUrl.host) return failure(403, "Host is not allowed");
    if (request.headers.get("tailscale-user-login") !== allowedLogin) return failure(403, "Tailscale identity is not allowed");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== publicUrl.origin) return failure(403, "Origin is not allowed");
    if (request.headers.get("sec-fetch-site") === "cross-site") return failure(403, "Cross-site request is not allowed");
    if (landingPath && url.pathname === "/" && ["GET", "HEAD"].includes(request.method)) {
      return new Response(null, { status: 307, headers: { location: landingPath, "cache-control": "private, no-store" } });
    }
    // Assign path components separately so a //path cannot select another host.
    const target = new URL(upstreamUrl);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = cleanHeaders(request.headers);
    headers.set("host", upstreamUrl.host);
    if (origin !== null) headers.set("origin", upstreamUrl.origin);
    try {
      const response = await fetch(target, {
        method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual", signal: request.signal, decompress: false,
      });
      const output = cleanHeaders(response.headers);
      output.delete("set-cookie");
      output.delete("refresh");
      output.set("cache-control", "private, no-store");
      const location = output.get("location");
      if (location !== null) {
        let redirect: URL;
        try { redirect = new URL(location, target); }
        catch { await response.body?.cancel(); return failure(502, "Invalid upstream redirect"); }
        const loopback = redirect.hostname === "localhost" || redirect.hostname.endsWith(".localhost") ||
          redirect.hostname.startsWith("127.") || ["0.0.0.0", "[::1]", "[::]"].includes(redirect.hostname) ||
          redirect.hostname.startsWith("[::ffff:");
        if (redirect.username || redirect.password || !["http:", "https:"].includes(redirect.protocol) ||
          (loopback && redirect.origin !== upstreamUrl.origin)) {
          await response.body?.cancel();
          return failure(502, "Upstream redirect is not allowed");
        }
        output.set("location", redirect.origin === upstreamUrl.origin
          ? `${publicUrl.origin}${redirect.pathname}${redirect.search}${redirect.hash}`
          : redirect.href);
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: output });
    } catch {
      return failure(502, "Canvas upstream is unavailable");
    }
  };
}

export function startTailnetGateway(config: TailnetGatewayConfig) {
  return Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 0, fetch: createTailnetGatewayHandler(config) });
}

if (import.meta.main) {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw new Error("Usage: bun tailnet-gateway.ts /absolute/config.json");
  const config = await Bun.file(configPath).json() as TailnetGatewayConfig;
  const server = startTailnetGateway(config);
  console.log(`Canvas tailnet gateway listening on 127.0.0.1:${server.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void server.stop(true); });
}
