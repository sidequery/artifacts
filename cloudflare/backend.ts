import { DurableObject } from "cloudflare:workers";
import type { ArtifactHttpRequest, ArtifactHttpResponse } from "../src/httpTypes";
import { createHash } from "node:crypto";
import type { ArtifactLibrary } from "./library";
import { scriptRuntimeConfig } from "./script-runtime";

import { ArtifactExecution, type ArtifactActive, type ArtifactClaim, type ArtifactScheduleInput } from "./artifact-execution";

export type BackendEnv = { LOADER: WorkerLoader; LIBRARIES: DurableObjectNamespace<ArtifactLibrary>; ARTIFACTS_RUNTIME?: string };
export const ARTIFACT_HEADER = "x-artifacts-backend";
const MAX_BODY = 256 * 1024;
type BackendCode = { code: string; hash: string; version_id?: string; trigger?: "http" | "manual" | "schedule" };

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
  const metadata = { status: response.status, statusText: response.statusText, headers: [...response.headers] };
  if ([204, 205, 304].includes(response.status) || method === "HEAD") {
    await response.body?.cancel();
    return metadata;
  }
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
  return { ...metadata, body: btoa(binary) };
}

/** One supervisor per authorized library/workspace/artifact. The user-authored
 * class runs in a separate isolate and owns its own native SQLite database. */
export class ArtifactBackend extends DurableObject<BackendEnv> {
  private activeKey: string | undefined;
  private execution: ArtifactExecution;
  constructor(state: DurableObjectState, env: BackendEnv) {
    super(state, env);
    this.execution = new ArtifactExecution(state.storage);
  }
  async secrets(input: { secrets?: Record<string, string | null> } = {}) {
    return this.ctx.storage.transaction(async storage => {
      const secrets = await storage.get<Record<string, string>>("secrets") ?? {};
      if (input.secrets !== undefined) {
        if (!input.secrets || typeof input.secrets !== "object" || Array.isArray(input.secrets)) throw new Error("secrets must be an object");
        for (const [key, value] of Object.entries(input.secrets)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("invalid secret key");
          if (value !== null && (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096)) throw new Error("secret exceeds 4 KiB");
          if (value === null) delete secrets[key];
          else secrets[key] = value;
        }
        if (Object.keys(secrets).length > 32 || new TextEncoder().encode(JSON.stringify(secrets)).byteLength > 32768) throw new Error("artifact secrets exceed 32 keys or 32 KiB");
        await storage.put("secrets", secrets);
      }
      return { ok: true, names: Object.keys(secrets).sort() };
    });
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
    // Errors are recorded by execute(). Never retry an invocation that may
    // already have committed application writes.
    try {
      const response = await this.execute({ ...active, code: active.code, trigger }, nativeRequest(request), claimed?.run);
      await response.body?.cancel();
    } catch {}
  }

  async request(input: BackendCode & { request: ArtifactHttpRequest }, claimedRun?: { id: string; started: number }): Promise<ArtifactHttpResponse> {
    const request = nativeRequest(input.request);
    return serializeResponse(await this.execute(input, request, claimedRun), request.method);
  }

  // Native fetch preserves streams on celld, whose generic RPC is data-only.
  async fetch(incoming: Request): Promise<Response> {
    const { libraryKey, workspace, name, compiled_id, version_id, original } = JSON.parse(incoming.headers.get(ARTIFACT_HEADER)!);
    const compiled = await this.env.LIBRARIES.getByName(libraryKey).compiled({ workspace, name, id: compiled_id });
    if (!compiled?.server_js) return Response.json({ error: "Artifact has no saved server bundle" }, { status: 409 });
    const request = new Request(incoming);
    if (original === null) request.headers.delete(ARTIFACT_HEADER);
    else request.headers.set(ARTIFACT_HEADER, original);
    const code = compiled.server_js;
    return this.execute({ code, hash: createHash("sha256").update(code).digest("hex"), version_id }, request);
  }

  private async execute(input: BackendCode, request: Request, claimedRun?: { id: string; started: number }): Promise<Response> {
    const active = input.version_id ? undefined : await this.execution.active();
    const revision = input.version_id ?? (active?.hash === input.hash ? active.version_id : input.hash);
    const run = claimedRun ?? this.execution.start(revision, input.trigger ?? "http");
    try {
      const secrets = await this.ctx.storage.get<Record<string, string>>("secrets") ?? {};
      const config = scriptRuntimeConfig(this.env.ARTIFACTS_RUNTIME);
      // Identical source owned by different artifacts must not share globals or secrets.
      const key = createHash("sha256").update(JSON.stringify([this.ctx.id.toString(), input.code, secrets, config])).digest("hex");
      if (this.activeKey !== key) {
        // Reload code while preserving the facet's database. Never delete/reset
        // storage as a side effect of an edit, preview, or source restoration.
        this.ctx.facets.abort("canvas", "Artifact server code or secrets updated");
        this.activeKey = key;
      }
      // This persisted facet key owns existing user databases.
      const facet = this.ctx.facets.get("canvas", () => {
        const worker = this.env.LOADER.get(key, async () => ({
          ...config,
          mainModule: "artifact-server.js",
          // Old immutable compiled revisions export CanvasServer. Preserve the
          // default Worker object too: celld requires it on the main module.
          modules: {
            "artifact-server.js": 'import * as source from "./source.js"; export const ArtifactServer = source.ArtifactServer ?? source.CanvasServer; export default source.default;',
            "source.js": input.code,
          },
          env: { secrets },
        }));
        return { class: worker.getDurableObjectClass("ArtifactServer") };
      });
      const response = await facet.fetch(request);
      this.execution.finish(run, response.status);
      return response;
    } catch (error) {
      this.execution.finish(run, null);
      throw error;
    }
  }
}
