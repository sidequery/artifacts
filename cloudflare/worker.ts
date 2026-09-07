import { Hono } from "hono";
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import { CanvasLibrary } from "./library";
import { authenticate, type AuthEnvironment } from "./auth";
import { CloudCanvasService } from "./service";
// esbuild 0.28.1 must initialize Better Auth's shared Zod module before
// the MCP SDK constructs its top-level schemas (Zod 4.5.4).
import { authenticateBetterAuth, getCanvasAuth, CanvasAuthConfigurationError, type BetterAuthEnvironment, type CanvasUser } from "./better-auth";
import { handleCloudMcp } from "./mcp";
import { readRequestText } from "./http";
import { CanvasBackend } from "./backend";
import { canvas_request as validateRequest } from "../dist/cloudflare/tool-validators.js";
import type { CanvasHttpRequest } from "../src/httpTypes";
import galleryBridge from "../dist/cloudflare/gallery-request.json";

import { ArtifactLinks } from "./links";
import { ScriptLibrary } from "./scripts";
import { ScriptBackend } from "./script-backend";
import { artifactRoute } from "./artifact-routes";
import * as toolValidators from "../dist/cloudflare/tool-validators.js";
export { CanvasLibrary, CanvasBackend, ArtifactLinks, ScriptLibrary, ScriptBackend };
export type Env = AuthEnvironment & BetterAuthEnvironment & {
  LIBRARIES: DurableObjectNamespace<CanvasLibrary>;
  BACKENDS: DurableObjectNamespace<CanvasBackend>;
  LINKS: DurableObjectNamespace<ArtifactLinks>;
  SCRIPTS: DurableObjectNamespace<ScriptLibrary>;
  SCRIPT_BACKENDS: DurableObjectNamespace<ScriptBackend>;
  ASSETS: Fetcher;
  DEFAULT_WORKSPACE?: string;
};

const app = new Hono<{ Bindings: Env; Variables: { service: CloudCanvasService; libraryScope: "private" | "team"; user: CanvasUser | null } }>();
app.get("/health", c => c.json({ ok: true, runtime: navigator.userAgent }));
app.get("/sign-in", c => {
  if (c.env.AUTH_MODE !== "better-auth") return c.redirect("/");
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return c.env.ASSETS.fetch(new Request(new URL("/auth.html", c.req.url)));
});
app.get("/consent", c => {
  if (c.env.AUTH_MODE !== "better-auth") return c.notFound();
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return c.env.ASSETS.fetch(new Request(new URL("/auth.html", c.req.url)));
});
app.get("/auth.js", c => c.env.ASSETS.fetch(c.req.raw));
app.get("/api/auth/providers", async c => {
  if (c.env.AUTH_MODE !== "better-auth") return c.json({ providers: [] });
  const context = await (await getCanvasAuth(c.env)).$context;
  // Publish display metadata only, never provider configuration or credentials.
  return c.json({ providers: context.socialProviders.map(({ id, name }) => ({ id, name })) });
});
app.all("/api/auth/*", async c => c.env.AUTH_MODE === "better-auth"
  ? (await getCanvasAuth(c.env)).handler(c.req.raw) : c.notFound());
app.all("/.well-known/*", async c => c.env.AUTH_MODE === "better-auth"
  ? (await getCanvasAuth(c.env)).handler(c.req.raw) : c.notFound());
app.use("*", async (c, next) => {
  const artifactOperation = artifactRoute(c.req.raw, c.env);
  c.executionCtx.waitUntil(artifactOperation);
  const artifact = await artifactOperation;
  if (artifact) return artifact;
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const url = new URL(c.req.url);
  const origin = c.req.header("Origin");
  if (origin && origin !== url.origin) return c.json({ error: "Origin is not allowed" }, 403);
  if (c.env.AUTH_MODE && !["access", "better-auth"].includes(c.env.AUTH_MODE)) return c.json({ error: "AUTH_MODE must be access or better-auth" }, 503);
  const user = c.env.AUTH_MODE === "better-auth" ? await authenticateBetterAuth(c.req.raw, c.env) : null;
  if (user instanceof Response) return user;
  const identity = user ? { subject: user.id } : await authenticate(c.req.raw, c.env);
  if (identity instanceof Response) return identity;
  c.set("user", user);
  const workspace = (url.searchParams.get("workspace") ?? c.env.DEFAULT_WORKSPACE ?? "default").trim();
  if (!workspace || workspace.includes("\0") || new TextEncoder().encode(workspace).byteLength > 4096) return c.json({ error: "Invalid workspace" }, 400);
  const libraryScope = url.searchParams.get("library") ?? "private";
  if (libraryScope !== "private" && libraryScope !== "team") return c.json({ error: "Library must be private or team" }, 400);
  // The configured auth mode controls membership of this deployment's team. Private storage is
  // selected only from the verified subject, never a caller-supplied user ID.
  const libraryKey = libraryScope === "team" ? "team" : user
    ? JSON.stringify(["private", "better-auth", user.id])
    : JSON.stringify(["private", c.env.ACCESS_TEAM_DOMAIN ?? "local", identity.subject]);
  c.set("libraryScope", libraryScope);
  c.set("service", new CloudCanvasService(c.env.LIBRARIES.getByName(libraryKey), workspace, c.env.BACKENDS, libraryKey, { links: c.env.LINKS.getByName("deployment"), scripts: c.env.SCRIPTS.getByName(libraryKey), scriptBackends: c.env.SCRIPT_BACKENDS, origin: url.origin }));
  // Compilation uses shared isolate resources. Let an admitted operation finish
  // after a client disconnects rather than abandoning its native compiler I/O.
  const operation = next();
  c.executionCtx.waitUntil(operation);
  await operation;
});
app.get("/api/session", c => {
  const user = c.get("user");
  return c.json({ authMode: user ? "better-auth" : "access", user: user ? { id: user.id, name: user.name, email: user.email } : null });
});

app.all("/mcp", async c => {
  let body: unknown;
  if (c.req.method === "POST") {
    try { body = JSON.parse(await readRequestText(c.req.raw, 1024 * 1024)); }
    catch (error) { return c.json({ error: error instanceof RangeError ? "Request exceeds 1 MiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  }
  return handleCloudMcp(c.req.raw, c.get("service"), body);
});
app.get("/api/gallery", async c => {
  const offset = Number(c.req.query("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "Invalid offset" }, 400);
  return c.json({ ...await c.get("service").gallery(c.req.query("all") === "1", offset), libraryScope: c.get("libraryScope") });
});
app.post("/api/canvas/request", async c => {
  let input: unknown;
  try { input = JSON.parse(await readRequestText(c.req.raw, 1024 * 1024)); }
  catch (error) { return c.json({ error: error instanceof RangeError ? "Request exceeds 1 MiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  if (!validateRequest(input)) return c.json({ error: "Invalid canvas request" }, 400);
  const args = input as { name?: string; version_id?: string; request: CanvasHttpRequest };
  return c.json({ response: await c.get("service").request({ name: args.name, version_id: args.version_id }, args.request) });
});
app.post("/api/tools", async c => {
  let input: { name?: string; arguments?: Record<string, unknown> };
  try { input = JSON.parse(await readRequestText(c.req.raw, 1024 * 1024)); }
  catch (error) { return c.json({ error: error instanceof RangeError ? "Request exceeds 1 MiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  if (!input || typeof input.name !== "string" || !Object.hasOwn(toolValidators, input.name)) return c.json({ error: "Unknown tool" }, 400);
  const validate = toolValidators[input.name as keyof typeof toolValidators];
  if (!validate(input.arguments ?? {})) return c.json({ error: "Invalid tool arguments" }, 400);
  return c.json(await c.get("service").callTool(input.name, input.arguments ?? {}));
});
app.get("/api/source", async c => {
  if (c.req.query("kind") === "script") {
    const source = await c.get("service").scriptReadSource({ name: c.req.query("name"), version_id: c.req.query("version") });
    c.header("Content-Type", "text/plain; charset=utf-8");
    if (c.req.query("download") === "1") c.header("Content-Disposition", 'attachment; filename="script.ts"');
    return c.body(source.source);
  }
  const snapshot = await c.get("service").snapshot({ name: c.req.query("name"), version_id: c.req.query("version") });
  c.header("Content-Type", "text/plain; charset=utf-8");
  if (c.req.query("download") === "1") c.header("Content-Disposition", `attachment; filename="canvas.canvas.tsx"; filename*=UTF-8''${encodeURIComponent(snapshot.name + ".canvas.tsx")}`);
  return c.body(snapshot.source);
});
app.get("/gallery/preview", async c => {
  const service = c.get("service");
  const snapshot = await service.snapshot({ name: c.req.query("name"), version_id: c.req.query("version"), event_id: c.req.query("event") });
  const preview = await service.preview(snapshot);
  if (!preview.ok || !preview._meta) return c.text(preview.check, 400);
  const payload = preview._meta.canvas;
  // Enforce isolation even if somebody opens the preview URL directly instead
  // of through the gallery's sandboxed iframe. Preview state is page-local.
  c.header("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sidequery Canvas preview</title><style>body{margin:0;background:#181818;color:#f0f0f0;font-family:system-ui,sans-serif}#root{padding:24px}</style></head><body><div id="root"></div><script>window.__herdrCanvas=${JSON.stringify({ canvasId: payload.name, state: payload.state, theme: { kind: "dark" }, ...(payload.server ? { serverVersionId: payload.versionId } : {}) }).replaceAll("<", "\\u003c")};${galleryBridge.replace(/<\/script/gi, "<\\/script")}</script><script type="module">${payload.js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
});
app.get("/", c => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));
app.get("/gallery", c => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));
app.get("/gallery.js", c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => c.json({ error: error.message }, error instanceof CanvasAuthConfigurationError ? 503 : /not found/.test(error.message) ? 404 : 400));

export default app;
