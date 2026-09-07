import { compileCanvasSource, typecheckCanvasSource } from "./compiler";
import { readRequestText } from "./http";

// Local compiler qualification entrypoint. The hosted API supplies its own
// authentication and storage boundaries before exposing these operations.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, runtime: navigator.userAgent });
    if (request.method !== "POST" || !["/compile", "/typecheck"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    let source: string;
    try { source = await readRequestText(request, 256 * 1024); }
    catch (error) {
      if (error instanceof RangeError) return new Response("Canvas source exceeds 256 KiB", { status: 413 });
      throw error;
    }
    return Response.json(url.pathname === "/compile" ? await compileCanvasSource(source) : { diagnostics: typecheckCanvasSource(source) });
  },
};
