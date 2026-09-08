import canvas from "../../cloudflare/worker";
import collector, { type Env as CollectorEnv } from "./worker";

export { CanvasLibrary, CanvasBackend, ArtifactLinks, ScriptLibrary, ScriptBackend } from "../../cloudflare/worker";
export { RunnerStatus } from "./worker";

// One application owns both the Canvas library and the shared polling object.
// The collector authenticates before touching its object or GitHub credentials.
export default {
  fetch(request: Request, env: Parameters<typeof canvas.fetch>[1] & CollectorEnv, context: Parameters<typeof canvas.fetch>[2]) {
    return new URL(request.url).pathname === "/api/status"
      ? collector.fetch(request, env)
      : canvas.fetch(request, env, context);
  },
};
