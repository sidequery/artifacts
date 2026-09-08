export { ArtifactBackend } from "./backend";
import type { ArtifactBackend } from "./backend";

type Env = { BACKENDS: DurableObjectNamespace<ArtifactBackend> };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const input = await request.json() as Parameters<ArtifactBackend["request"]>[0];
      return Response.json(await env.BACKENDS.getByName("existing").request(input));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
