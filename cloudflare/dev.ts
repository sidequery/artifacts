import { normalizeProject, emptyProject } from "./project";
import { compileArtifactSource, compileArtifactServerSource, compileScriptSource, typecheckArtifactSource, typecheckArtifactServerSource } from "./compiler";
import { readRequestText } from "./http";
import type { ExecutionContext } from "@cloudflare/workers-types";

// Local compiler qualification entrypoint. The hosted API supplies its own
// authentication and storage boundaries before exposing these operations.
export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, runtime: navigator.userAgent });
    if (request.method !== "POST" || !["/compile", "/compile-server", "/compile-script", "/typecheck", "/typecheck-server"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    let source: string;
    let project = emptyProject();
    try { source = await readRequestText(request, request.headers.get("content-type")?.includes("application/json") ? 10 * 1024 * 1024 : 256 * 1024); }
    catch (error) {
      if (error instanceof RangeError) return new Response("Artifact source exceeds 256 KiB", { status: 413 });
      throw error;
    }
    if (request.headers.get("content-type")?.includes("application/json")) {
      const input = JSON.parse(source);
      source = input.source; project = normalizeProject(input.project);
    }
    const compilation = url.pathname === "/compile-script" ? compileScriptSource(source, project)
      : url.pathname === "/compile-server" ? compileArtifactServerSource(source, project)
      : url.pathname === "/compile" ? compileArtifactSource(source, project) : undefined;
    if (compilation) ctx.waitUntil(compilation);
    return Response.json(compilation ? await compilation
      : { diagnostics: url.pathname === "/typecheck-server" ? typecheckArtifactServerSource(source, project) : typecheckArtifactSource(source, project) });
  },
};
