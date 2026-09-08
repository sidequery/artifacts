import { CloudCanvasService, type HostedArtifacts } from "./service";
import { CanvasLibrary } from "./library";
import { ArtifactLinks } from "./links";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export { CanvasLibrary, ArtifactLinks };
type Env = { LIBRARY: DurableObjectNamespace<CanvasLibrary>; LINKS: DurableObjectNamespace<ArtifactLinks> };

// The integration harness replaces compiler.ts with an instrumented compiler.
// Storage, revision activation and all service read/write paths remain real.
declare global {
  var compilerProbe: { allowed: boolean; client: number; server: number };
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/compiler") {
        if (request.method === "POST") globalThis.compilerProbe.allowed = (await request.json() as { allowed: boolean }).allowed;
        return Response.json(globalThis.compilerProbe);
      }
      const libraryKey = url.searchParams.get("library") ?? "alice";
      const workspace = url.searchParams.get("workspace") ?? "default";
      const library = env.LIBRARY.getByName(libraryKey);
      const links = env.LINKS.getByName("deployment");
      const backends = { getByName: (key: string) => ({ request: async (input: { code: string; hash: string }) => ({ status: 200, headers: [], body: btoa(JSON.stringify({ key, ...input })) }) }) };
      const service = new CloudCanvasService(library, workspace, backends as never, libraryKey, { links, origin: url.origin } as HostedArtifacts);
      const input = await request.json() as Record<string, any>;
      if (url.pathname === "/tool") return Response.json(await service.callTool(input.name, input.arguments));
      if (url.pathname === "/preview") return Response.json(await service.preview(await service.snapshot(input)));
      if (url.pathname === "/request") return Response.json(await service.request(input, { path: "/", method: "GET", headers: [] }));
      if (url.pathname === "/state") return Response.json(await library.setState({ workspace, ...input }));
      if (url.pathname === "/active") {
        const link = await links.get(input.slug);
        if (!link) return new Response("Missing", { status: 404 });
        return Response.json(await service.preview(await service.snapshot({ version_id: link.version_id! })));
      }
      if (url.pathname === "/legacy") {
        const draft = await library.writeDraft({ workspace, ...input });
        return Response.json(await library.recordServe({ ...draft, runtime: "pre-artifacts", initial_state: {}, mode: "preview" }));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
};
