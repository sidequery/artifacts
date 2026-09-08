export { ArtifactLibrary } from "./library";
export { ScriptLibrary } from "./scripts";
export { ArtifactLinks } from "./links";
import type { ArtifactLibrary } from "./library";
import type { ScriptLibrary } from "./scripts";
import type { ArtifactLinks } from "./links";

export default {
  async fetch(request: Request, env: { LIBRARIES: DurableObjectNamespace<ArtifactLibrary>; SCRIPTS: DurableObjectNamespace<ScriptLibrary>; LINKS: DurableObjectNamespace<ArtifactLinks> }) {
    const input = await request.json() as { binding: "LIBRARIES" | "SCRIPTS" | "LINKS"; library?: string; method: string; args: unknown[] };
    const stub = env[input.binding].getByName(input.library ?? "deployment") as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    try { return Response.json({ result: await stub[input.method]!(...input.args) }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  },
};
