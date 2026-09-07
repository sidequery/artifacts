import { compileCanvasSource, compileCanvasServerSource, compileScriptSource, typecheckCanvasSource, typecheckCanvasServerSource } from "./compiler";
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
    try { source = await readRequestText(request, 256 * 1024); }
    catch (error) {
      if (error instanceof RangeError) return new Response("Canvas source exceeds 256 KiB", { status: 413 });
      throw error;
    }
    const compilation = url.pathname === "/compile-script" ? compileScriptSource(source)
      : url.pathname === "/compile-server" ? compileCanvasServerSource(source)
      : url.pathname === "/compile" ? compileCanvasSource(source) : undefined;
    if (compilation) ctx.waitUntil(compilation);
    return Response.json(compilation ? await compilation
      : { diagnostics: url.pathname === "/typecheck-server" ? typecheckCanvasServerSource(source) : typecheckCanvasSource(source) });
  },
};
