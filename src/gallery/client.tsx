import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { authClient, signInUrl } from "../auth/client-api";
import type { GalleryArtifact, GalleryData } from "./types";
import { CanvasSourcePanel, LinkSettings, ScriptPanel } from "./hosted";
import { canvasFileTransferUrl } from "../sdk/files";
import { RemixPanel } from "./remix";

type Scope = "current" | "all";
type DetailTab = "preview" | "source";
type SourceState =
  | { status: "idle"; text: ""; error: "" }
  | { status: "loading"; text: ""; error: "" }
  | { status: "ready"; text: string; error: "" }
  | { status: "error"; text: ""; error: string };

const WORKING_VERSION = "working";

type SessionUser = { id: string; name: string; email: string };

const styles = `
  :root { color-scheme: dark; --page: #141414; --line: #303030; --muted: #a0a0a0; }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; }
  body { margin: 0; background: var(--page); color: #e0e0e0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  button, input, select, a { font: inherit; color: inherit; touch-action: manipulation; }
  button, select, .download-link { cursor: pointer; }
  button, select, input { min-height: 32px; border: 1px solid transparent; border-radius: 3px; background: transparent; padding: 5px 9px; }
  select, input { border-color: var(--line); min-width: 0; }
  select { background: var(--page); }
  button:disabled { opacity: .5; cursor: wait; }
  :is(button, input, select, a):focus-visible { outline: 2px solid #bcbcbc; outline-offset: -2px; }
  .gallery-app { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
  .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .search-input { width: 204px; }
  .search-input::placeholder { color: var(--muted); }
  .toolbar-spacer { flex: 1; }
  .version-select { max-width: 300px; }
  .view-control { display: flex; gap: 2px; }
  .view-control button[aria-pressed="true"] { background: #303030; }
  .download-link { display: inline-flex; align-items: center; min-height: 32px; padding: 5px 9px; text-decoration: none; }
  .account { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .account-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .gallery-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); flex: 1; min-height: 0; }
  .library-panel { overflow: auto; border-right: 1px solid var(--line); padding: 6px; }
  .artifact-row { display: block; width: 100%; text-align: left; padding: 8px; }
  .artifact-row[aria-current="true"] { background: #303030; }
  .artifact-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; margin-top: 3px; }
  .artifact-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .artifact-detail .canvas-stage { flex: 1; }
  .link-settings, .script-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .link-settings { padding: 8px; border-bottom: 1px solid var(--line); }
  .link-settings label { display: flex; align-items: center; gap: 4px; }
  .script-panel { width: 100%; padding: 16px; overflow: auto; }
  .script-panel label { display: block; }
  .script-panel textarea { display: block; width: 100%; min-height: 70px; margin: 6px 0 12px; color: inherit; background: #191919; border: 1px solid var(--line); padding: 10px; font: 12px/1.6 "SFMono-Regular", Consolas, monospace; resize: vertical; }
  .script-panel .source-editor { min-height: 280px; }
  .script-panel details { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
  .script-panel summary { cursor: pointer; }
  .script-panel pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
  .canvas-stage { position: relative; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
  .preview-frame { display: block; width: 100%; height: 100%; border: 0; }
  .preview-loading { position: absolute; inset: 0; display: grid; place-items: center; background: var(--page); color: var(--muted); pointer-events: none; }
  .source-code { flex: 1; min-width: 0; margin: 0; padding: 16px; overflow: auto; font: 12px/1.6 "SFMono-Regular", Consolas, monospace; tab-size: 2; }
  .state-message { margin: 0; padding: 12px; color: var(--muted); }
  .canvas-stage > .state-message { margin: auto; }
  .error-message { color: #eeaaaa; }
  .refresh-error { padding: 8px 12px; margin: 0; border-bottom: 1px solid var(--line); }
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled), .download-link:hover { background: #262626; }
    .artifact-row[aria-current="true"]:hover { background: #303030; }
  }
  @media (max-width: 760px) {
    .toolbar-spacer { display: none; }
    .search-input { flex: 1; width: 140px; }
    .version-select { max-width: 230px; }
    .gallery-layout { grid-template-columns: 170px minmax(0, 1fr); }
  }
  @media (max-width: 480px) {
    .gallery-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: 112px minmax(0, 1fr); }
    .library-panel { border-right: 0; border-bottom: 1px solid var(--line); }
  }
  @media (pointer: coarse) {
    button, input, select, .download-link { min-height: 44px; }
    input, select { font-size: 16px; }
  }
`;

function isGalleryResponse(value: unknown): value is GalleryData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GalleryData>;
  return typeof candidate.workspace === "string" && Array.isArray(candidate.artifacts);
}

function sessionUser(value: unknown): SessionUser | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { authMode?: unknown; user?: Partial<SessionUser> };
  if (candidate.authMode !== "better-auth" || !candidate.user
    || typeof candidate.user.id !== "string" || typeof candidate.user.name !== "string"
    || typeof candidate.user.email !== "string") return null;
  return candidate.user as SessionUser;
}

function redirectExpiredSession(response: Response): boolean {
  if (response.status !== 401 || response.headers.get("X-Canvas-Auth") !== "better-auth") return false;
  window.location.assign(signInUrl());
  return true;
}

function galleryUrl(scope: Scope, offset = 0): string {
  const params = new URLSearchParams();
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  const workspace = new URLSearchParams(window.location.search).get("workspace");
  if (workspace) params.set("workspace", workspace);
  if (scope === "all") params.set("all", "1");
  if (offset) params.set("offset", String(offset));
  const query = params.toString();
  return `/api/gallery${query ? `?${query}` : ""}`;
}

function artifactUrl(path: "/api/source" | "/gallery/preview", artifact: GalleryArtifact, version: string, download = false): string {
  const params = new URLSearchParams();
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  params.set("workspace", artifact.workspace);
  if (artifact.kind === "script") params.set("kind", "script");
  if (version === WORKING_VERSION) params.set("name", artifact.name);
  else params.set("version", version);
  if (download) params.set("download", "1");
  return `${path}?${params.toString()}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function App() {
  const [remixing, setRemixing] = useState(false);
  const [creatingScript, setCreatingScript] = useState(false);
  const [scope, setScope] = useState<Scope>("current");
  const [query, setQuery] = useState("");
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("preview");
  const [loading, setLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [source, setSource] = useState<SourceState>({ status: "idle", text: "", error: "" });
  const [previewLoading, setPreviewLoading] = useState(true);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const createdRemix = useRef<{name:string;workspace:string;kind:string} | null>(null);
  const createdScriptName = useRef<string | null>(null);
  const galleryController = useRef<AbortController | null>(null);
  const galleryRequest = useRef(0);
  const sourceRequest = useRef(0);
  const previewFrame = useRef<HTMLIFrameElement>(null);

  const loadGallery = useCallback(async () => {
    galleryController.current?.abort();
    const controller = new AbortController();
    galleryController.current = controller;
    const request = ++galleryRequest.current;
    setLoading(true);
    setGalleryError("");

    try {
      let offset = 0;
      let payload: GalleryData;
      const artifacts = new Map<string, GalleryArtifact>();
      do {
        const response = await fetch(galleryUrl(scope, offset), {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (redirectExpiredSession(response)) return;
        if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
        const page: unknown = await response.json();
        if (!isGalleryResponse(page)) throw new Error("The gallery returned an unexpected response.");
        for (const artifact of page.artifacts) {
          const previous = artifacts.get(artifact.key);
          const versions = new Map([...(previous?.versions ?? []), ...artifact.versions].map(version => [version.id, version]));
          artifacts.set(artifact.key, { ...artifact, working: artifact.working || !!previous?.working, versions: [...versions.values()] });
        }
        payload = { ...page, artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)) };
        if (page.nextOffset === undefined || page.nextOffset === null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid gallery pagination.");
        offset = page.nextOffset;
      } while (!controller.signal.aborted);
      if (request !== galleryRequest.current) return;

      setGallery(payload);
      setRefreshEpoch((epoch) => epoch + 1);
      const created = createdScriptName.current;
      createdScriptName.current = null;
      const remix = createdRemix.current;
      createdRemix.current = null;
      setSelectedKey((current) => {
        if (remix) return payload.artifacts.find(artifact => (artifact.kind ?? "canvas") === remix.kind && artifact.name === remix.name && artifact.workspace === remix.workspace)?.key ?? current;
        if (created) return payload.artifacts.find(artifact => artifact.kind === "script" && artifact.name === created)?.key ?? current;
        if (current && payload.artifacts.some((artifact) => artifact.key === current)) return current;
        return payload.artifacts[0]?.key ?? null;
      });
    } catch (error) {
      if (controller.signal.aborted || request !== galleryRequest.current) return;
      setGalleryError(error instanceof Error ? error.message : "Could not load the canvas library.");
    } finally {
      if (request === galleryRequest.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void loadGallery();
    return () => galleryController.current?.abort();
  }, [loadGallery]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/session", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (redirectExpiredSession(response) || !response.ok) return;
        const resolved = sessionUser(await response.json());
        if (!controller.signal.aborted) setUser(resolved);
      } catch {
        // Local Canvas servers do not expose an auth session endpoint.
      }
    })();
    return () => controller.abort();
  }, []);

  const filteredArtifacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!gallery || !normalized) return gallery?.artifacts ?? [];
    return gallery.artifacts.filter((artifact) =>
      `${artifact.name}\n${artifact.workspace}`.toLocaleLowerCase().includes(normalized),
    );
  }, [gallery, query]);

  const selectedArtifact = useMemo(
    () => gallery?.artifacts.find((artifact) => artifact.key === selectedKey) ?? null,
    [gallery, selectedKey],
  );

  const sortedVersions = useMemo(
    () => [...(selectedArtifact?.versions ?? [])].sort((left, right) => right.revision - left.revision),
    [selectedArtifact],
  );

  const resolvedVersion = useMemo(() => {
    if (!selectedArtifact) return null;
    if (selectedVersion === WORKING_VERSION && selectedArtifact.working) return WORKING_VERSION;
    if (selectedVersion && sortedVersions.some((version) => version.id === selectedVersion)) return selectedVersion;
    if (selectedArtifact.working) return WORKING_VERSION;
    return sortedVersions[0]?.id ?? null;
  }, [selectedArtifact, selectedVersion, sortedVersions]);

  useEffect(() => {
    setSelectedVersion(resolvedVersion);
  }, [resolvedVersion]);

  const previewUrl = selectedArtifact && selectedArtifact.kind !== "script" && resolvedVersion
    ? `${artifactUrl("/gallery/preview", selectedArtifact, resolvedVersion)}&refresh=${refreshEpoch}`
    : "";
  const downloadUrl = selectedArtifact && resolvedVersion
    ? artifactUrl("/api/source", selectedArtifact, resolvedVersion, true)
    : "";

  useEffect(() => {
    const pending = new Set<string>();
    const request = async (event: MessageEvent) => {
      const frame = previewFrame.current;
      if (!frame || event.source !== frame.contentWindow || !selectedArtifact
        || !["canvas/http-request", "canvas/plugin-request", "canvas/files-request", "canvas/file-download"].includes(event.data?.type) || typeof event.data.id !== "string"
        || event.data.id.length > 64 || (event.data.type !== "canvas/plugin-request" && typeof event.data.versionId !== "string") || pending.has(event.data.id)) return;
      const plugin = event.data.type === "canvas/plugin-request";
      const files = event.data.type === "canvas/files-request";
      const download = event.data.type === "canvas/file-download";
      const responseType = plugin ? "canvas/plugin-response" : files ? "canvas/files-response" : download ? "canvas/file-download-response" : "canvas/http-response";
      const target = frame.contentWindow!;
      const id = event.data.id;
      try {
        if (pending.size >= 16) throw new Error("Too many pending canvas requests");
        pending.add(id);
        if (download) {
          const url = canvasFileTransferUrl(event.data.url, window.location.origin);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "";
          anchor.rel = "noopener";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          target.postMessage({ type: responseType, id, result: null }, "*");
          return;
        }
        const params = new URLSearchParams({ workspace: selectedArtifact.workspace });
        const library = new URLSearchParams(window.location.search).get("library");
        if (library) params.set("library", library);
        const response = await fetch(`${plugin ? "/api/plugins/call" : files ? "/api/canvas/files" : "/api/canvas/request"}?${params}`, {
          method: "POST", headers: { "content-type": "application/json" },
          // The frame selects its pinned code version, but cannot redirect a
          // request to another canvas or private/team library.
          body: JSON.stringify(plugin ? event.data.request : { name: selectedArtifact.name, version_id: event.data.versionId, request: event.data.request }),
        });
        if (redirectExpiredSession(response)) return;
        const result = await response.json() as { response?: unknown; result?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error ?? `Canvas request failed (${response.status})`);
        target.postMessage({ type: responseType, id, response: result.response, result: result.result }, "*");
      } catch (error) {
        target.postMessage({ type: responseType, id, error: error instanceof Error ? error.message : String(error) }, "*");
      } finally { pending.delete(id); }
    };
    window.addEventListener("message", request);
    return () => window.removeEventListener("message", request);
  }, [selectedArtifact]);

  useEffect(() => {
    if (tab !== "source" || !selectedArtifact || selectedArtifact.kind === "script" || !resolvedVersion) {
      setSource({ status: "idle", text: "", error: "" });
      return;
    }

    const controller = new AbortController();
    const request = ++sourceRequest.current;
    setSource({ status: "loading", text: "", error: "" });

    void (async () => {
      try {
        const response = await fetch(artifactUrl("/api/source", selectedArtifact, resolvedVersion), {
          signal: controller.signal,
          headers: { Accept: "text/plain" },
        });
        if (redirectExpiredSession(response)) return;
        if (!response.ok) throw new Error(`Source request failed (${response.status})`);
        const text = await response.text();
        if (!controller.signal.aborted && request === sourceRequest.current) {
          setSource({ status: "ready", text, error: "" });
        }
      } catch (error) {
        if (controller.signal.aborted || request !== sourceRequest.current) return;
        setSource({
          status: "error",
          text: "",
          error: error instanceof Error ? error.message : "Could not load this source file.",
        });
      }
    })();

    return () => controller.abort();
  }, [resolvedVersion, selectedArtifact, tab]);

  useEffect(() => {
    if (tab === "preview") setPreviewLoading(true);
  }, [previewUrl, tab]);

  const selectArtifact = (artifact: GalleryArtifact) => {
    setCreatingScript(false);
    setRemixing(false);
    setSelectedKey(artifact.key);
    setSelectedVersion(artifact.working ? WORKING_VERSION : [...artifact.versions].sort((a, b) => b.revision - a.revision)[0]?.id ?? null);
  };

  const signOut = async () => {
    setSigningOut(true);
    setAccountError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw result.error;
      window.location.assign(signInUrl());
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not sign out.");
      setSigningOut(false);
    }
  };

  const downloadSource = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!user) return;
    event.preventDefault();
    try {
      const response = await fetch(downloadUrl, { headers: { Accept: "text/plain" } });
      if (redirectExpiredSession(response)) return;
      if (!response.ok) throw new Error(`Source download failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selectedArtifact?.name ?? "canvas"}${selectedArtifact?.kind === "script" ? ".ts" : ".canvas.tsx"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not download this source file.");
    }
  };

  return (
    <>
      <style>{styles}</style>
      <main className="gallery-app">
        <div className="toolbar" aria-label="Canvas controls">
          {gallery?.libraryScope ? (
            <select aria-label="Library" value={gallery.libraryScope} onChange={event => {
              const url = new URL(window.location.href);
              url.searchParams.set("library", event.target.value);
              window.location.assign(url.href);
            }}>
              <option value="private">My library</option>
              <option value="team">Team library</option>
            </select>
          ) : null}
          <input
            className="search-input"
            type="search"
            aria-label={gallery?.capabilities?.scripts ? "Search canvases and scripts" : "Search canvases"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            autoComplete="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore
          />
          <select aria-label="Project scope" value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
            <option value="current">Current project</option>
            <option value="all">All projects</option>
          </select>
          {gallery?.capabilities?.scripts ? <button onClick={() => setCreatingScript(true)}>New script</button> : null}
          <div className="toolbar-spacer" />
          {!creatingScript && selectedArtifact && resolvedVersion ? (
            <>
              <select className="version-select" aria-label="Version" value={resolvedVersion} onChange={(event) => setSelectedVersion(event.target.value)}>
                {selectedArtifact.working ? <option value={WORKING_VERSION}>Working copy</option> : null}
                {sortedVersions.map((version) => (
                  <option key={version.id} value={version.id}>Revision {version.revision} · {formatDate(version.createdAt)}</option>
                ))}
              </select>
              {selectedArtifact.kind !== "script" ? <div className="view-control" role="group" aria-label="Canvas view">
                <button type="button" aria-pressed={tab === "preview"} aria-controls="canvas-panel" onClick={() => setTab("preview")}>Preview</button>
                <button type="button" aria-pressed={tab === "source"} aria-controls="canvas-panel" onClick={() => setTab("source")}>Source</button>
              </div> : null}
              <button type="button" onClick={() => setRemixing(true)}>Remix</button>
              <a className="download-link" href={downloadUrl} download onClick={downloadSource}>Download source</a>
            </>
          ) : null}
          <button type="button" onClick={() => void loadGallery()} disabled={loading} aria-label={loading ? "Refreshing canvases" : "Refresh"}>Refresh</button>
          {user ? (
            <div className="account">
              <span className="account-name" title={user.email}>{user.name}</span>
              <button type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
            </div>
          ) : null}
        </div>

        {galleryError && gallery ? <p role="alert" className="refresh-error error-message">Refresh failed: {galleryError}. Showing the last loaded files.</p> : null}
        {accountError ? <p role="alert" className="refresh-error error-message">{accountError}</p> : null}

        <div className="gallery-layout">
          <aside className="library-panel" aria-label={gallery?.capabilities?.scripts ? "Canvases and scripts" : "Canvases"}>
            {loading && !gallery ? (
              <p className="state-message" role="status">Loading…</p>
            ) : galleryError && !gallery ? (
              <div role="alert">
                <p className="state-message error-message">{galleryError}</p>
                <button type="button" onClick={() => void loadGallery()}>Try again</button>
              </div>
            ) : filteredArtifacts.length === 0 ? (
              <p className="state-message">{query ? "No matches" : gallery?.capabilities?.scripts ? "No canvases or scripts" : "No canvases"}</p>
            ) : filteredArtifacts.map((artifact) => (
              <button
                className="artifact-row"
                type="button"
                key={artifact.key}
                title={artifact.workspace + "/" + artifact.name}
                aria-current={artifact.key === selectedKey ? "true" : undefined}
                onClick={() => selectArtifact(artifact)}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
              >
                <span className="artifact-name">{artifact.name}</span>
                {artifact.kind === "script" ? <span className="workspace-name">Script{artifact.slug ? ` · /${artifact.slug}` : ""}</span> : null}
                {scope === "all" ? <span className="workspace-name">{artifact.workspace}</span> : null}
              </button>
            ))}
          </aside>
          <div className="artifact-detail">
          {remixing && !creatingScript && selectedArtifact && resolvedVersion ? <RemixPanel key={selectedArtifact.key + resolvedVersion} artifact={selectedArtifact} version={resolvedVersion} onCancel={() => setRemixing(false)} onSaved={async name => { createdRemix.current = {name,workspace:selectedArtifact.workspace,kind:selectedArtifact.kind ?? "canvas"}; await loadGallery(); setSelectedVersion("working"); setQuery(""); setRemixing(false); }} /> : null}
          {!creatingScript && selectedArtifact && gallery?.capabilities?.links ? <LinkSettings key={selectedArtifact.key} artifact={selectedArtifact} onSaved={loadGallery} /> : null}
          <section id="canvas-panel" className="canvas-stage" aria-label={tab === "preview" ? "Canvas preview" : "Canvas source"}>
            {creatingScript ? (
              <ScriptPanel key="new-script" workspace={gallery?.workspace ?? "default"} onCancel={() => setCreatingScript(false)} onSaved={async name => { createdScriptName.current = name; await loadGallery(); setCreatingScript(false); setSelectedVersion("working"); setQuery(""); }} />
            ) : selectedArtifact?.kind === "script" ? (
              <ScriptPanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} workspace={selectedArtifact.workspace} version={resolvedVersion ?? undefined} sourceUrl={resolvedVersion ? artifactUrl("/api/source", selectedArtifact, resolvedVersion) : undefined} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
            ) : !selectedArtifact ? (
              <p className="state-message">Select a canvas</p>
            ) : !resolvedVersion ? (
              <p className="state-message">No readable version</p>
            ) : tab === "preview" ? (
              <>
                {previewLoading ? <div className="preview-loading" role="status">Loading preview…</div> : null}
                <iframe
                  ref={previewFrame}
                  key={previewUrl}
                  className="preview-frame"
                  src={previewUrl}
                  title={`Preview of ${selectedArtifact.name}`}
                  sandbox="allow-scripts"
                  onLoad={() => setPreviewLoading(false)}
                />
              </>
            ) : gallery?.capabilities?.links ? (
              <CanvasSourcePanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} version={resolvedVersion} sourceUrl={artifactUrl("/api/source", selectedArtifact, resolvedVersion)} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
            ) : source.status === "ready" ? (
              <pre className="source-code" tabIndex={0} aria-label={`Source of ${selectedArtifact.name}`}><code>{source.text}</code></pre>
            ) : source.status === "error" ? (
              <p role="alert" className="state-message error-message">{source.error}</p>
            ) : (
              <p className="state-message" role="status">Loading source…</p>
            )}
          </section>
          </div>
        </div>
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
