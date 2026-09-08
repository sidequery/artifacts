import { resolveArtifactFile } from "./artifactFile";
import { readLocalProject } from "./localProject";
import { projectSourceHash, type ArtifactProject } from "../cloudflare/project";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertRegularArtifact, ensureArtifactFileName } from "./artifactFile";
import { compileArtifact } from "./compile";
import { ArtifactHistory, hash, historyPath, runtimeIdentity, type Version } from "./history";
import { ArtifactService } from "./service";
import { artifactHtml } from "./html";
import { galleryBundle, galleryData, galleryHtml, workingSource } from "./gallery/server";

export type ArtifactServer = { url: string; port: number; stop: () => void };
export type ArtifactActionEvent = { type: string; [key: string]: unknown };
export type CreateArtifactServerOptions = {
  artifactsDir: string;
  port?: number;
  hostname?: string;
  historyPath?: string;
  env?: NodeJS.ProcessEnv;
  onAction?: (artifactId: string, action: ArtifactActionEvent) => void;
  compile?: typeof compileArtifact;
  runtimeIdentity?: typeof runtimeIdentity;
  gallery?: boolean;
};

export async function createArtifactServer(opts: CreateArtifactServerOptions): Promise<ArtifactServer> {
  const compile = opts.compile ?? compileArtifact;
  const artifactsDir = resolve(opts.artifactsDir);
  const env = opts.env ?? process.env;
  const history = new ArtifactHistory(opts.historyPath ?? historyPath(env));
  const identifyRuntime = opts.runtimeIdentity ?? runtimeIdentity;
  let galleryJs: Promise<string> | undefined;
  const states = new Map<string, Record<string, unknown>>();
  // Bundles exist only in this server's memory; the archive stores raw TSX.
  const builds = new Map<string, Promise<{ js: string; runtime: string; project: ArtifactProject } | undefined>>();
  const build = (path: string, source: string, requestedRuntime?: string, project: ArtifactProject = readLocalProject(path)) => {
    const runtime = identifyRuntime();
    const runtimeHash = hash(runtime);
    const key = (requestedRuntime ?? runtimeHash) + ":" + path + ":" + projectSourceHash(source, project);
    let pending = builds.get(key);
    if (!pending) {
      // A page must never silently execute a different SDK generation than its event.
      if (requestedRuntime && requestedRuntime !== runtimeHash) return Promise.resolve(undefined);
      pending = compile(path, source, undefined, project).then(result => {
        if (!result.ok || !result.js) { builds.delete(key); return undefined; }
        if (identifyRuntime() !== runtime) { builds.delete(key); throw new Error("Artifact SDK changed during compilation; reload to retry"); }
        return { js: result.js, runtime, project };
      }).catch(error => { builds.delete(key); throw error; });
      builds.set(key, pending);
      if (builds.size > 16) builds.delete(builds.keys().next().value!);
    }
    return pending;
  };

  function versionPage(version: Version, state: Record<string, unknown>, replay: boolean, runtime: string, inlineBundle?: string): Response {
    const eventId = history.served(version.id, state, inlineBundle ? "preview" : replay ? "replay" : "live", env, runtime);
    const base = "/c/" + encodeURIComponent(version.name);
    return new Response(artifactHtml({
      title: version.name,
      artifactId: version.name,
      versionId: version.id,
      eventId,
      // A self-contained data module lets gallery previews run in an opaque sandbox
      // without granting artifact code access to the gallery or exposing bundle CORS.
      scriptUrl: inlineBundle ? `data:text/javascript;base64,${Buffer.from(inlineBundle).toString("base64")}` : "/v/" + version.id + "/bundle.js?runtime=" + hash(runtime),
      persistUrl: replay ? undefined : base + "/state",
      actionUrl: replay ? undefined : base + "/action",
      mtimeUrl: replay ? undefined : base + "/mtime",
      sourceHash: version.source_hash,
      state,
    }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port ?? 0,
      hostname: opts.hostname ?? "127.0.0.1",
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.pathname === "/health") return json({ ok: true });

          if (opts.gallery && url.pathname === "/api/tools" && request.method === "POST") {
            // The gallery is a loopback UI. Untrusted websites and opaque artifact
            // previews must not be able to create local files through this endpoint.
            const allowedHosts = new Set([opts.hostname ?? "127.0.0.1"]);
            if (["127.0.0.1", "::1", "localhost"].includes(opts.hostname ?? "127.0.0.1")) {
              for (const host of ["127.0.0.1", "[::1]", "localhost"]) allowedHosts.add(host);
            }
            if (!allowedHosts.has(url.hostname) || request.headers.get("origin") !== url.origin || !request.headers.get("content-type")?.startsWith("application/json")) {
              return json({ ok: false, error: "same-origin JSON request required" }, 403);
            }
            const workspace = url.searchParams.get("workspace");
            if (workspace && resolve(workspace) !== artifactsDir) return json({ ok: false, error: "open this workspace's gallery to remix its artifact" }, 400);
            const body = await request.json() as { name?: string; arguments?: Parameters<ArtifactService["remix"]>[0] };
            if (body.name !== "artifact_remix" || !body.arguments) return json({ ok: false, error: "unknown tool" }, 400);
            try {
              const service = new ArtifactService({ artifactsDir, env: { ...env, ARTIFACTS_HISTORY_DB: history.path } });
              return json(service.remix(body.arguments));
            } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
          }

          if (opts.gallery && request.method === "GET") {
            if (url.pathname === "/" || url.pathname === "/gallery") return new Response(galleryHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
            if (url.pathname === "/gallery.js") {
              galleryJs ??= galleryBundle().catch(error => { galleryJs = undefined; throw error; });
              return javascript(await galleryJs);
            }
            if (url.pathname === "/api/gallery") return json(galleryData(history, artifactsDir, url.searchParams.get("all") === "1"));
            if (url.pathname === "/api/source" || url.pathname === "/gallery/preview") {
              const versionId = url.searchParams.get("version");
              const name = url.searchParams.get("name");
              if (Boolean(versionId) === Boolean(name)) return json({ error: "provide name or version, but not both" }, 400);
              let version = versionId ? history.version(versionId) : null;
              if (versionId && !version) return new Response("version not found", { status: 404 });
              let source: string;
              let sourcePath: string;
              let artifactName: string;
              try {
                const selected = version ? { source: version.source, path: version.source_path, name: version.name } : workingSource(artifactsDir, name!);
                source = selected.source; sourcePath = selected.path; artifactName = selected.name;
              } catch { return new Response("working artifact not found or not a regular file", { status: 404 }); }
              if (url.pathname === "/api/source") {
                return new Response(source, { headers: {
                  "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
                  ...(url.searchParams.get("download") === "1" ? { "content-disposition": `attachment; filename="artifact.artifact.tsx"; filename*=UTF-8''${encodeURIComponent(artifactName + ".artifact.tsx")}` } : {}),
                } });
              }
              const compiled = await build(sourcePath, source, undefined, version?.project);
              if (!compiled) return new Response("This source does not compile with the installed SDK.", { status: 400 });
              const initialState = version ? (() => { const events = history.events(version.id); const event = events.find(item => item.mode === "live") ?? events[0]; return event ? JSON.parse(event.initial_state) : {}; })() : loadState(sourcePath, states, artifactName);
              version ??= history.capture({ workspace: artifactsDir, name: artifactName, sourcePath, source, project: compiled.project, runtime: compiled.runtime });
              return versionPage(version, initialState, true, compiled.runtime, compiled.js);
            }
          }

          const archived = url.pathname.match(/^\/v\/([a-f0-9-]+)(\/bundle\.js)?$/);
          if (archived && request.method === "GET") {
            const version = history.version(archived[1], artifactsDir);
            if (!version) return new Response("version not found", { status: 404 });
            const requestedRuntime = archived[2] ? url.searchParams.get("runtime") ?? undefined : undefined;
            const compiled = await build(version.source_path, version.source, requestedRuntime, version.project);
            if (!compiled) return new Response(requestedRuntime ? "page build expired or no longer compiles; reload the page" : "archived source does not compile with the installed SDK", { status: requestedRuntime ? 409 : 400 });
            if (archived[2]) return javascript(compiled.js);
            const events = history.events(version.id);
            const eventId = url.searchParams.get("event");
            const event = eventId ? events.find(item => item.id === eventId) : events.find(item => item.mode === "live") ?? events[0];
            if (eventId && !event) return new Response("serve event not found for version", { status: 404 });
            return versionPage(version, event ? JSON.parse(event.initial_state) : {}, true, compiled.runtime);
          }

          const match = url.pathname.match(/^\/c\/([^/]+)(?:\/(.*))?$/);
          if (!match) return new Response("not found", { status: 404 });
          let artifactId: string;
          try {
            artifactId = decodeURIComponent(match[1]);
            ensureArtifactFileName(artifactId);
          } catch { return new Response("invalid artifact name", { status: 400 }); }
          const rest = match[2] ?? "";
          const filePath = resolveArtifactFile(artifactId, artifactsDir);
          if (!existsSync(filePath)) return new Response("artifact not found", { status: 404 });
          try { assertRegularArtifact(filePath); }
          catch { return new Response("artifact source must be a regular file", { status: 400 }); }

          if (rest === "mtime" && request.method === "GET") {
            // Content identity also detects editors that preserve modification timestamps.
            return json({ mtime: hash(readFileSync(filePath, "utf8")) });
          }
          if (rest === "state" && request.method === "GET") return json(loadState(filePath, states, artifactId));
          if (rest === "state" && request.method === "PUT") {
            const body = (await request.json()) as { key?: string; value?: unknown };
            if (typeof body.key !== "string" || !body.key || ["__proto__", "constructor", "prototype"].includes(body.key)) return json({ ok: false, error: "invalid key" }, 400);
            const current = { ...loadState(filePath, states, artifactId), [body.key]: body.value };
            writeFileSync(stateSidecar(filePath), JSON.stringify(current, null, 2) + "\n");
            states.set(artifactId, current);
            return json({ ok: true });
          }
          if (rest === "action" && request.method === "POST") {
            opts.onAction?.(artifactId, (await request.json()) as ArtifactActionEvent);
            return json({ ok: true });
          }

          if (request.method === "GET" && ["", "bundle.js", artifactId + ".js"].includes(rest)) {
            const source = readFileSync(filePath, "utf8");
            const compiled = await build(filePath, source);
            if (!compiled) return new Response("compile failed", { status: 400 });
            const version = history.capture({ workspace: artifactsDir, name: artifactId, sourcePath: filePath, source, project: compiled.project, runtime: compiled.runtime });
            if (rest) return javascript(compiled.js);
            return versionPage(version, loadState(filePath, states, artifactId), false, compiled.runtime);
          }
          return new Response("not found", { status: 404 });
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
    });
  } catch (error) { history.close(); throw error; }

  let stopped = false;
  return {
    url: "http://127.0.0.1:" + server.port,
    port: server.port ?? 0,
    stop() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
      history.close();
      builds.clear();
    },
  };
}

function javascript(js: string): Response {
  return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}
function stateSidecar(artifactPath: string): string { return artifactPath.replace(/\.tsx$/, ".data.json"); }
function loadState(filePath: string, states: Map<string, Record<string, unknown>>, artifactId: string): Record<string, unknown> {
  const cached = states.get(artifactId);
  if (cached) return cached;
  const sidecar = stateSidecar(filePath);
  if (existsSync(sidecar)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        states.set(artifactId, parsed as Record<string, unknown>);
        return parsed as Record<string, unknown>;
      }
    } catch { /* Keep malformed sidecars untouched; start with empty UI state. */ }
  }
  const empty = {};
  states.set(artifactId, empty);
  return empty;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
