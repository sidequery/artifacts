import { afterEach, describe, expect, test } from "bun:test";
import { createTailnetGatewayHandler, startTailnetGateway, type TailnetGatewayConfig } from "./tailnet-gateway";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });
const publicOrigin = "https://canvas.example.ts.net";
const allowedLogin = "owner@example.com";

function fixture(upstream: (request: Request) => Response | Promise<Response>, landingPath?: string) {
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: upstream });
  const config: TailnetGatewayConfig = { publicOrigin, allowedLogin, upstreamOrigin: backend.url.origin, port: 0, landingPath };
  const gateway = startTailnetGateway(config);
  servers.push(backend, gateway);
  const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, gateway.url), {
    ...init, redirect: "manual",
    headers: { host: new URL(publicOrigin).host, "tailscale-user-login": allowedLogin, ...Object.fromEntries(new Headers(init.headers)) },
  });
  return { request, config, gateway };
}

describe("single-owner tailnet gateway over HTTP", () => {
  test("gates every route and rejects identity, host, and origin spoofing before upstream", async () => {
    let calls = 0;
    const { request } = fixture(() => { calls++; return new Response("unexpected"); }, "/runner-status/runners");
    for (const path of ["/", "/health", "/public-script", "/api/gallery", "/mcp"]) {
      const rejectedHeaders: Record<string, string>[] = [
        { "tailscale-user-login": "" },
        { "tailscale-user-login": "other@example.com" },
        { "tailscale-user-login": `${allowedLogin}, other@example.com` },
        { "tailscale-user-login": "", "tailscale-user-name": allowedLogin, "cf-access-authenticated-user-email": allowedLogin },
        { origin: "https://evil.example" },
        { origin: "null" },
        { origin: `${publicOrigin}/` },
        { host: "evil.example", "x-forwarded-host": new URL(publicOrigin).host },
        { "sec-fetch-site": "cross-site" },
      ];
      for (const headers of rejectedHeaders) expect((await request(path, { headers })).status).toBe(403);
    }
    expect(calls).toBe(0);
  });

  test("forwards pages, query and POST bodies while hiding identity and preserving MCP protocol", async () => {
    const { request, config } = fixture(async req => Response.json({
      url: req.url, method: req.method, body: await req.text(), headers: Object.fromEntries(req.headers),
    }));
    const page = await (await request("/runner-status/runners?view=all%20hosts")).json();
    expect(page.url).toBe(`${config.upstreamOrigin}/runner-status/runners?view=all%20hosts`);
    expect(page.method).toBe("GET");
    const result = await (await request("/mcp?workspace=private", { method: "POST", body: '{"jsonrpc":"2.0"}', headers: {
      origin: publicOrigin, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26", "mcp-session-id": "session-1", "last-event-id": "event-2",
      "tailscale-user-name": "Owner", "tailscale-user-profile-pic": "private", "tailscale-custom": "secret",
      "cf-access-jwt-assertion": "secret", "cf-access-client-secret": "secret", cookie: "session=secret",
      authorization: "Bearer secret", forwarded: "host=evil.example", "x-forwarded-host": "evil.example",
    } })).json();
    expect(result.url).toBe(`${config.upstreamOrigin}/mcp?workspace=private`);
    expect(result.body).toBe('{"jsonrpc":"2.0"}');
    expect(result.headers.origin).toBe(config.upstreamOrigin);
    expect(result.headers.host).toBe(new URL(config.upstreamOrigin).host);
    expect(result.headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect(result.headers["mcp-session-id"]).toBe("session-1");
    expect(result.headers["last-event-id"]).toBe("event-2");
    expect(result.headers.accept).toBe("application/json, text/event-stream");
    // Public scripts can implement their own bearer authentication. Core Canvas
    // strips Authorization before invoking private scripts.
    expect(result.headers.authorization).toBe("Bearer secret");
    for (const name of Object.keys(result.headers)) {
      expect(name.startsWith("tailscale-") || name.startsWith("cf-access-") || name.startsWith("x-forwarded-")).toBe(false);
      expect(["cookie", "forwarded"].includes(name)).toBe(false);
    }
    expect((await request("/public-script", { method: "POST", body: "script input" })).status).toBe(200);
  });

  test("root redirect is authenticated and optional", async () => {
    const { request } = fixture(() => new Response("gallery"), "/runner-status/runners");
    const response = await request("/");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/runner-status/runners");
    expect(await (await fixture(() => new Response("gallery")).request("/")).text()).toBe("gallery");
  });

  test("rewrites local redirects, preserves external redirects without following them, and rejects unsafe targets", async () => {
    let calls = 0;
    const { request } = fixture(req => {
      calls++;
      const url = new URL(req.url);
      return new Response(null, { status: 302, headers: { location: url.searchParams.get("to")!, "set-cookie": "identity=secret", refresh: "0;url=http://localhost" } });
    });
    for (const location of ["/next?a=1#section", "next?a=1#section"]) {
      const response = await request(`/?to=${encodeURIComponent(location)}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${publicOrigin}/next?a=1#section`);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("refresh")).toBeNull();
    }
    const { request: localRequest } = fixture(req => new Response(null, { status: 307, headers: { location: `${new URL(req.url).origin}/next` } }));
    expect((await localRequest("/")).headers.get("location")).toBe(`${publicOrigin}/next`);
    for (const location of ["https://external.example/next", "http://external.example/next"]) {
      const response = await request(`/?to=${encodeURIComponent(location)}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(location);
    }
    for (const location of ["http://localhost:9999/", "http://127.0.0.2/", "http://[::1]/", "javascript:alert(1)", "https://user:pass@canvas.example.ts.net/"]) {
      expect((await request(`/?to=${encodeURIComponent(location)}`)).status).toBe(502);
    }
    expect(calls).toBe(9);
  });

  test("delivers an SSE chunk before upstream completes", async () => {
    let finish!: () => void;
    const { request } = fixture(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        finish = () => { controller.enqueue(new TextEncoder().encode("data: last\n\n")); controller.close(); };
      },
    }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "stream-session" } }));
    const response = await request("/mcp", { signal: AbortSignal.timeout(3000) });
    expect(response.headers.get("mcp-session-id")).toBe("stream-session");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  test("validates trusted configuration and binds only loopback", () => {
    const { config, gateway } = fixture(() => new Response("ok"));
    expect(gateway.hostname).toBe("127.0.0.1");
    for (const override of [
      { publicOrigin: "http://canvas.example.ts.net" }, { publicOrigin: `${publicOrigin}/` },
      { upstreamOrigin: "http://192.168.1.1:4786" }, { upstreamOrigin: "http://127.0.0.1:4786/path" },
      { allowedLogin: "" }, { allowedLogin: "a,b" }, { landingPath: "//evil.example" }, { landingPath: "/\\evil.example" }, { port: -1 },
    ]) expect(() => createTailnetGatewayHandler({ ...config, ...override })).toThrow();
  });
});
