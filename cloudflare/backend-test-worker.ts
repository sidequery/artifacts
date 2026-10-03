export { ArtifactBackend } from "./backend";
export { ArtifactLibrary } from "./library";
import type { ArtifactBackend } from "./backend";
import type { ArtifactLibrary } from "./library";
import { ARTIFACT_HEADER } from "./backend";

type Env = { BACKENDS: DurableObjectNamespace<ArtifactBackend>; LIBRARIES: DurableObjectNamespace<ArtifactLibrary> };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    const name = url.searchParams.get("name") ?? "existing";
    const backend = env.BACKENDS.getByName(name);
    try {
      if (url.pathname === "/secrets") return Response.json(await backend.secrets(await request.json()));
      if (url.pathname === "/activate") { await backend.activate(await request.json()); return Response.json({ ok: true }); }
      if (url.pathname === "/schedule") return Response.json(await backend.schedule(await request.json()));
      if (url.pathname === "/runs") return Response.json(await backend.runs());
      if (url.pathname === "/prepare") {
        const { code } = await request.json() as { code: string };
        const saved = await env.LIBRARIES.getByName("test").saveCompiled({ workspace: "test", name, source: "fixture", server_source: code,
          runtime: "fixture", client_js: "fixture", server_js: code });
        return Response.json({ compiled_id: saved.id });
      }
      if (url.pathname.startsWith("/api")) {
        const input = new Request(request);
        input.headers.set(ARTIFACT_HEADER, JSON.stringify({ libraryKey: "test", workspace: "test", name,
          compiled_id: request.headers.get("x-test-compiled-id"), version_id: "test", original: request.headers.get(ARTIFACT_HEADER) }));
        return backend.fetch(input);
      }
      const input = await request.json() as Parameters<ArtifactBackend["request"]>[0];
      return Response.json(await backend.request(input));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
