import { DurableObject } from "cloudflare:workers";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "../src/httpTypes";

import { ArtifactExecution, type ArtifactActive, type ArtifactClaim, type ArtifactScheduleInput } from "./artifact-execution";

export type BackendEnv = { LOADER: WorkerLoader };
const MAX_BODY = 256 * 1024;

function decode(body: string): Uint8Array {
  if (body.length > Math.ceil(MAX_BODY / 3) * 4) throw new Error("Artifact request body exceeds 256 KiB");
  const binary = atob(body);
  if (binary.length > MAX_BODY) throw new Error("Artifact request body exceeds 256 KiB");
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function nativeRequest(input: ArtifactHttpRequest): Request {
  if (typeof input.path !== "string" || input.path.length > 8192 || !input.path.startsWith("/")) throw new Error("Artifact request path must start with /");
  const url = new URL(input.path, "https://artifact.invalid");
  if (url.origin !== "https://artifact.invalid") throw new Error("Artifact requests cannot select another origin");
  return new Request(url, { method: input.method, headers: input.headers,
    ...(input.body === undefined ? {} : { body: decode(input.body) }),
  });
}

async function serializeResponse(response: Response, method: string): Promise<ArtifactHttpResponse> {
  const reader = response.body?.getReader();
  let binary = "";
  try {
    if (reader) while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (binary.length + chunk.value.length > MAX_BODY) {
        await reader.cancel();
        throw new Error("Artifact response body exceeds 256 KiB");
      }
      for (let i = 0; i < chunk.value.length; i += 8192) binary += String.fromCharCode(...chunk.value.subarray(i, i + 8192));
    }
  } finally { reader?.releaseLock(); }
  return { status: response.status, statusText: response.statusText, headers: [...response.headers],
    ...([204, 205, 304].includes(response.status) || method === "HEAD" ? {} : { body: btoa(binary) }),
  };
}

/** One supervisor per authorized library/workspace/artifact. The user-authored
 * class runs in a separate isolate and owns its own native SQLite database. */
export class ArtifactBackend extends DurableObject<BackendEnv> {
  private activeCode: string | undefined;
  private execution: ArtifactExecution;
  constructor(state: DurableObjectState, env: BackendEnv) {
    super(state, env);
    this.execution = new ArtifactExecution(state.storage);
  }
  activate(input: ArtifactActive) { return this.execution.activate(input); }
  async activeRevision() {
    const active = await this.execution.active();
    return active ? { version_id: active.version_id, revision: active.revision, has_server: active.code !== null } : null;
  }
  runs(input: { limit?: number } = {}) { return this.execution.runs(input.limit); }
  async schedule(input: ArtifactScheduleInput = {}) {
    if (input.request) {
      nativeRequest(input.request);
      input = { ...input, request: { ...input.request, method: input.request.method ?? "GET", headers: input.request.headers ?? [] } };
    }
    if (input.action === "run_now") {
      const schedule = await this.execution.get();
      if (!schedule) throw new Error("No schedule configured");
      await this.runScheduled(schedule.request, "manual");
      return this.execution.get();
    }
    return this.execution.update(input);
  }
  async alarm() {
    const claimed = await this.execution.claim();
    if (claimed) await this.runScheduled(claimed.schedule.request, "schedule", claimed);
  }
  private async runScheduled(request: ArtifactHttpRequest, trigger: "manual" | "schedule", claimed?: ArtifactClaim) {
    const active = claimed ? claimed.active : await this.execution.active();
    if (!active?.code) {
      const run = claimed?.run ?? this.execution.start(active?.version_id ?? "unavailable", trigger);
      this.execution.finish(run, null);
      return;
    }
    // Errors are recorded by request(). Never retry an invocation that may
    // already have committed application writes.
    try { await this.request({ ...active, code: active.code, request, trigger }, claimed?.run); } catch {}
  }

  async request(input: { code: string; hash: string; version_id?: string; request: ArtifactHttpRequest; trigger?: "http" | "manual" | "schedule" }, claimedRun?: { id: string; started: number }): Promise<ArtifactHttpResponse> {
    const request = nativeRequest(input.request);
    const active = input.version_id ? undefined : await this.execution.active();
    const revision = input.version_id ?? (active?.hash === input.hash ? active.version_id : input.hash);
    const run = claimedRun ?? this.execution.start(revision, input.trigger ?? "http");
    try {
      if (this.activeCode !== input.hash) {
        // Reload code while preserving the facet's database. Never delete/reset
        // storage as a side effect of an edit, preview, or source restoration.
        this.ctx.facets.abort("canvas", "Artifact server code updated");
        this.activeCode = input.hash;
      }
      // This persisted facet key owns existing user databases.
      const facet = this.ctx.facets.get("canvas", () => {
        const worker = this.env.LOADER.get(input.hash, async () => ({
          compatibilityDate: "2026-09-06",
          mainModule: "artifact-server.js",
          // Old immutable compiled revisions export CanvasServer. Preserve the
          // default Worker object too: celld requires it on the main module.
          modules: {
            "artifact-server.js": 'import * as source from "./source.js"; export const ArtifactServer = source.ArtifactServer ?? source.CanvasServer; export default source.default;',
            "source.js": input.code,
          },
          globalOutbound: null,
        }));
        return { class: worker.getDurableObjectClass("ArtifactServer") };
      });
      const response = await serializeResponse(await facet.fetch(request), request.method);
      this.execution.finish(run, response.status);
      return response;
    } catch (error) {
      this.execution.finish(run, null);
      throw error;
    }
  }
}
