export { ArtifactLinks } from "./links";
import type { ArtifactLinks } from "./links";
export default {
  async fetch(request: Request, env: { LINKS: DurableObjectNamespace<ArtifactLinks> }) {
    const { method, args } = await request.json() as { method: string; args: unknown[] };
    const links = env.LINKS.getByName("deployment") as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    try { return Response.json({ result: await links[method]!(...args) }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  },
};
