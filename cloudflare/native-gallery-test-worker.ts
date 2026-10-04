export { ArtifactLibrary } from "./library";
export { ScriptLibrary } from "./scripts";
export { ArtifactLinks } from "./links";
export { NativeApps } from "./native-worker/controller";
import { ManagedArtifactService } from "./managed-service";
import type { Env } from "./worker";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const owner = url.searchParams.get("owner") ?? "alice";
    const workspace = url.searchParams.get("workspace") ?? "default";
    const service = new ManagedArtifactService(env, workspace, owner, "alice", url.origin, url.origin, { user: { subject: owner, authority: "test" }, env });
    try {
      if (url.pathname === "/subscribe") return service.subscribeGallery(url.searchParams.get("all") === "1");
      if (url.pathname === "/gallery") return Response.json(await service.gallery(url.searchParams.get("all") === "1", Number(url.searchParams.get("offset") ?? 0)));
      if (url.pathname === "/seed-artifact") return Response.json(await env.LIBRARIES.getByName(owner).writeDraft({ workspace, name: "report", source: "source" }));
      const input = await request.json() as { name: string; arguments: Record<string, unknown> };
      return Response.json(await service.callTool(input.name, input.arguments));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
};
