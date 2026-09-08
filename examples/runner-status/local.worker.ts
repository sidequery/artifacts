import artifact from "../../cloudflare/worker";
import collector, { type Env as CollectorEnv } from "./worker";

export { ArtifactLibrary, ArtifactBackend, ArtifactFiles, CanvasLibrary, CanvasBackend, CanvasFiles, ArtifactLinks, ScriptLibrary, ScriptBackend } from "../../cloudflare/worker";
export { RunnerStatus } from "./worker";

// One application owns both the Artifact library and the shared polling object.
// The collector authenticates before touching its object or GitHub credentials.
export default {
  fetch(request: Request, env: Parameters<typeof artifact.fetch>[1] & CollectorEnv, context: Parameters<typeof artifact.fetch>[2]) {
    return new URL(request.url).pathname === "/api/status"
      ? collector.fetch(request, env)
      : artifact.fetch(request, env, context);
  },
};
