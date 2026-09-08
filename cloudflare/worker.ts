import { Hono } from "hono";
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";
import { ArtifactLibrary } from "./library";
import { authenticate, type AuthEnvironment } from "./auth";
import { CloudArtifactService } from "./service";
// esbuild 0.28.1 must initialize Better Auth's shared Zod module before
// the MCP SDK constructs its top-level schemas (Zod 4.5.4).
import { authenticateBetterAuth, getArtifactAuth, ArtifactAuthConfigurationError, type BetterAuthEnvironment, type ArtifactUser } from "./better-auth";
import { handleCloudMcp } from "./mcp";
import { readRequestText } from "./http";
import { ArtifactBackend } from "./backend";
import { ArtifactFiles, ArtifactFileError, TRANSFER_PATH } from "./files";
import type { ArtifactFileRequest } from "../src/sdk/files";
import { artifact_request as validateRequest } from "../dist/cloudflare/tool-validators.js";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import { PluginError, PLUGIN_JSON_LIMIT } from "./plugins";
import type { PluginRequest } from "../src/plugins/types";
import galleryBridge from "../dist/cloudflare/gallery-request.json";

import { ArtifactLinks } from "./links";
import { ScriptLibrary } from "./scripts";
import { ScriptBackend } from "./script-backend";
import { artifactRoute } from "./artifact-routes";
import * as toolValidators from "../dist/cloudflare/tool-validators.js";
export { ArtifactLibrary, ArtifactBackend, ArtifactFiles, ArtifactLinks, ScriptLibrary, ScriptBackend };
// Deployed Durable Object exports retain their storage identities.
export { ArtifactLibrary as CanvasLibrary, ArtifactBackend as CanvasBackend, ArtifactFiles as CanvasFiles };
export type Env = AuthEnvironment & BetterAuthEnvironment & {
  LIBRARIES: DurableObjectNamespace<ArtifactLibrary>;
  BACKENDS: DurableObjectNamespace<ArtifactBackend>;
  LINKS: DurableObjectNamespace<ArtifactLinks>;
  SCRIPTS: DurableObjectNamespace<ScriptLibrary>;
  SCRIPT_BACKENDS: DurableObjectNamespace<ScriptBackend>;
  FILE_BACKENDS?: DurableObjectNamespace<ArtifactFiles>;
  ASSETS: Fetcher;
  DEFAULT_WORKSPACE?: string;
};

const app = new Hono<{ Bindings: Env; Variables: { service: CloudArtifactService; libraryScope: "private" | "team"; user: ArtifactUser | null } }>();
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
  const context = await (await getArtifactAuth(c.env)).$context;
  // Publish display metadata only, never provider configuration or credentials.
  return c.json({ providers: context.socialProviders.map(({ id, name }) => ({ id, name })) });
});
app.all("/api/auth/*", async c => c.env.AUTH_MODE === "better-auth"
  ? (await getArtifactAuth(c.env)).handler(c.req.raw) : c.notFound());
app.all("/.well-known/*", async c => c.env.AUTH_MODE === "better-auth"
  ? (await getArtifactAuth(c.env)).handler(c.req.raw) : c.notFound());
// Only bearer transfer URLs bypass login. A grant fixes the artifact, file,
// method, size and expiry; management cookies confer no transfer authority.
for (const path of ["/api/artifact/files/transfer/:object/:token", "/api/canvas/files/transfer/:object/:token"]) app.all(path, async c => {
  const match = new URL(c.req.url).pathname.match(TRANSFER_PATH);
  if (!match || !c.env.FILE_BACKENDS) return c.notFound();
  let id;
  try { id = c.env.FILE_BACKENDS.idFromString(match[1]!); } catch { return c.notFound(); }
  return c.env.FILE_BACKENDS.get(id).fetch(c.req.raw);
});
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
  const identity = user ? { subject: user.id, authority: "better-auth" } : await authenticate(c.req.raw, c.env);
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
  c.set("service", new CloudArtifactService(c.env.LIBRARIES.getByName(libraryKey), workspace, c.env.BACKENDS, libraryKey, { links: c.env.LINKS.getByName("deployment"), scripts: c.env.SCRIPTS.getByName(libraryKey), scriptBackends: c.env.SCRIPT_BACKENDS, origin: url.origin }, { user: identity, env: c.env }, c.env.FILE_BACKENDS ? { backends: c.env.FILE_BACKENDS, origin: url.origin } : undefined));
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
app.post("/api/plugins/call", async c => {
  let input: PluginRequest;
  try { input = JSON.parse(await readRequestText(c.req.raw, PLUGIN_JSON_LIMIT)); }
  catch (error) { return c.json({ error: error instanceof RangeError ? "Plugin input exceeds 256 KiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  return c.json({ result: await c.get("service").pluginCall(input) });
});
app.post("/api/artifact/request", async c => {
  let input: unknown;
  try { input = JSON.parse(await readRequestText(c.req.raw, 1024 * 1024)); }
  catch (error) { return c.json({ error: error instanceof RangeError ? "Request exceeds 1 MiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  if (!validateRequest(input)) return c.json({ error: "Invalid artifact request" }, 400);
  const args = input as { name?: string; version_id?: string; request: ArtifactHttpRequest };
  return c.json({ response: await c.get("service").request({ name: args.name, version_id: args.version_id }, args.request) });
});
app.post("/api/artifact/files", async c => {
  let input: unknown;
  try { input = JSON.parse(await readRequestText(c.req.raw, 8192)); }
  catch (error) { return c.json({ error: error instanceof RangeError ? "File request exceeds 8 KiB" : "Invalid JSON" }, error instanceof RangeError ? 413 : 400); }
  if (!toolValidators.artifact_files(input)) return c.json({ error: "Invalid file request" }, 400);
  const args = input as { name?: string; version_id?: string; request: ArtifactFileRequest };
  return c.json({ result: await c.get("service").fileRequest(args, args.request) });
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
    if (c.req.query("format") === "json") return c.json(source);
    c.header("Content-Type", "text/plain; charset=utf-8");
    if (c.req.query("download") === "1") c.header("Content-Disposition", 'attachment; filename="script.ts"');
    return c.body(source.source);
  }
  const snapshot = await c.get("service").snapshot({ name: c.req.query("name"), version_id: c.req.query("version") });
  if (c.req.query("format") === "json") return c.json(snapshot);
  c.header("Content-Type", "text/plain; charset=utf-8");
  if (c.req.query("download") === "1") c.header("Content-Disposition", `attachment; filename="artifact.artifact.tsx"; filename*=UTF-8''${encodeURIComponent(snapshot.name + ".artifact.tsx")}`);
  return c.body(snapshot.source);
});
app.get("/gallery/preview", async c => {
  const service = c.get("service");
  const snapshot = await service.snapshot({ name: c.req.query("name"), version_id: c.req.query("version"), event_id: c.req.query("event") });
  const preview = await service.preview(snapshot);
  if (!preview.ok || !preview._meta) return c.text(preview.check, 400);
  const payload = preview._meta.artifact;
  // Enforce isolation even if somebody opens the preview URL directly instead
  // of through the gallery's sandboxed iframe. Preview state is page-local.
  c.header("Content-Security-Policy", `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ${new URL(c.req.url).origin}/api/artifact/files/transfer/ ${new URL(c.req.url).origin}/api/canvas/files/transfer/; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`);
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sidequery Artifacts preview</title><style>body{margin:0;background:#181818;color:#f0f0f0;font-family:system-ui,sans-serif}#root{padding:24px}</style></head><body><div id="root"></div><script>window.__herdrCanvas=window.__artifacts=${JSON.stringify({ artifactId: payload.name, canvasId: payload.name, state: payload.state, theme: { kind: "dark" }, plugins: payload.plugins, ...(payload.files ? { filesVersionId: payload.versionId } : {}), ...(payload.server ? { serverVersionId: payload.versionId } : {}) }).replaceAll("<", "\\u003c")};${galleryBridge.replace(/<\/script/gi, "<\\/script")}</script><script type="module">${payload.js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
});
app.get("/", c => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));
app.get("/gallery", c => c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))));
app.get("/gallery.js", c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => c.json({ error: error.message }, error instanceof PluginError || error instanceof ArtifactFileError ? error.status : error instanceof ArtifactAuthConfigurationError ? 503 : /not found/.test(error.message) ? 404 : 400));

export default app;
