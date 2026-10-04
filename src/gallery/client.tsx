import { Tabs } from "@base-ui/react/tabs";
import { Menu } from "@base-ui/react/menu";
import { LibraryNavigation } from "./library-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { authClient, signInUrl } from "../auth/client-api";
import type { GalleryArtifact, GalleryData, GalleryWorker } from "./types";
import { ExecutionControls } from "./execution-controls";
import { SecretControls } from "./secrets";
import { AgentOnboarding, ArtifactSourcePanel, LinkSettings, ScriptPanel, type ScriptView } from "./hosted";
import { artifactFileTransferUrl } from "../sdk/files";
import { RemixPanel } from "./remix";
import { Select } from "./select";
import { MovePanel } from "./move";
import { SourceEditor } from "./source-editor";
import { DraftProvider, confirmLeavingDrafts, useDrafts } from "./drafts";
import { ProjectImportPanel } from "./project-transfer";
import { NativeAppEditor, type NativeAppEditorHandle } from "./native-apps";
import { galleryStyles } from "./styles";
import { subscribeGallery } from "./subscription";

type Scope = "current" | "all";
type DetailTab = "preview" | "source" | "schedule" | "requests" | "settings";
type KindFilter = "all" | "artifact" | "script" | "worker";
type WorkerSelection = { workspace: string; name: string | null };
function workerSelection(): WorkerSelection | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "workers" ? { workspace: params.get("workspace") ?? "default", name: params.get("app") } : null;
}
type SourceState =
  | { status: "idle"; text: ""; error: "" }
  | { status: "loading"; text: ""; error: "" }
  | { status: "ready"; text: string; error: "" }
  | { status: "error"; text: ""; error: string };

const WORKING_VERSION = "working";

type SessionUser = { id: string; name: string; email: string };


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
  if (response.status !== 401 || response.headers.get("X-Artifact-Auth") !== "better-auth") return false;
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
  const { drafts } = useDrafts();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("artifacts-theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("artifacts-theme", theme); } catch { /* The theme still works when storage is unavailable. */ }
  }, [theme]);
  const [remixing, setRemixing] = useState(false);
  const [creatingKind, setCreatingKind] = useState<"artifact" | "script" | null>(null);
  const [selectedWorker, setSelectedWorker] = useState(workerSelection);
  const showNativeApps = selectedWorker !== null;
  const workerEditor = useRef<NativeAppEditorHandle>(null);
  // Selecting another item resets its editor; saving a new app keeps its feedback and draft state.
  const workerEditorKey = useRef(0);
  const navigationUrl = useRef(window.location.href);
  const scope: Scope = "all";
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [showLinks, setShowLinks] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [sourceVisited, setSourceVisited] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(() => workerSelection() !== null);
  const [narrowLayout, setNarrowLayout] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const libraryPanel = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const wasMobileDetail = useRef(false);
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>(() => {
    const value = new URLSearchParams(window.location.search).get("tab");
    if (value === "activity") return "schedule";
    if (value === "secrets") return "settings";
    return ["preview", "source", "schedule", "requests", "settings"].includes(value ?? "") ? value as DetailTab : "preview";
  });
  const [loading, setLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [source, setSource] = useState<SourceState>({ status: "idle", text: "", error: "" });
  const [previewLoading, setPreviewLoading] = useState(true);
  const [liveConnected, setLiveConnected] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState("");
  const createdRemix = useRef<{name:string;workspace:string;kind:string} | null>(null);
  const galleryController = useRef<AbortController | null>(null);
  const galleryRequest = useRef(0);
  const sourceRequest = useRef(0);
  const previewFrame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrowLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (narrowLayout && mobileDetail) detailHeading.current?.focus({ preventScroll: true });
    else if (narrowLayout && wasMobileDetail.current) libraryPanel.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    wasMobileDetail.current = mobileDetail;
  }, [mobileDetail, narrowLayout]);

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
      const workerApps = new Map<string, GalleryWorker>();
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
        for (const worker of page.workerApps ?? []) workerApps.set(worker.key, worker);
        payload = { ...page, workerApps: [...workerApps.values()], artifacts: [...artifacts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)) };
        if (page.nextOffset === undefined || page.nextOffset === null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid gallery pagination.");
        offset = page.nextOffset;
      } while (!controller.signal.aborted);
      if (request !== galleryRequest.current) return;

      setGallery(previous => {
        const existing = new Map(previous?.artifacts.map(item => [item.key, item]));
        return { ...payload, artifacts: payload.artifacts.map(item => {
          const before = existing.get(item.key);
          return before && JSON.stringify(before) === JSON.stringify(item) ? before : item;
        }) };
      });
      const remix = createdRemix.current;
      createdRemix.current = null;
      setSelectedKey((current) => {
        if (remix) return payload.artifacts.find(artifact => (artifact.kind ?? "artifact") === remix.kind && artifact.name === remix.name && artifact.workspace === remix.workspace)?.key ?? current;
        if (current && payload.artifacts.some((artifact) => artifact.key === current)) return current;
        const selection = new URLSearchParams(window.location.search);
        return payload.artifacts.find(item => item.name === selection.get("name") && item.workspace === (selection.get("workspace") ?? payload.workspace) && (item.kind ?? "artifact") === (selection.get("kind") ?? "artifact"))?.key ?? payload.artifacts[0]?.key ?? null;
      });
    } catch (error) {
      if (controller.signal.aborted || request !== galleryRequest.current) return;
      setGalleryError(error instanceof Error ? error.message : "Could not load the artifact library.");
    } finally {
      if (request === galleryRequest.current) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void loadGallery();
    return () => galleryController.current?.abort();
  }, [loadGallery]);

  useEffect(() => {
    if (!gallery?.capabilities?.subscriptions) return;
    const url = new URL(galleryUrl(scope), window.location.href);
    url.pathname = "/api/gallery/subscribe";
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return subscribeGallery(url.href, () => void loadGallery(), setLiveConnected);
  }, [gallery?.capabilities?.subscriptions, scope, loadGallery]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/session", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (redirectExpiredSession(response) || !response.ok) return;
        const resolved = sessionUser(await response.json());
        if (!controller.signal.aborted) setUser(resolved);
      } catch {
        // Local Artifact servers do not expose an auth session endpoint.
      }
    })();
    return () => controller.abort();
  }, []);

  const libraryItems = useMemo(() => [...(gallery?.artifacts ?? []), ...(gallery?.workerApps ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace)), [gallery]);
  const filteredArtifacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return libraryItems.filter((artifact) =>
      (kindFilter === "all" || (artifact.kind ?? "artifact") === kindFilter) &&
      (!normalized || `${artifact.name}\n${artifact.workspace}`.toLocaleLowerCase().includes(normalized)),
    );
  }, [libraryItems, query, kindFilter]);

  const selectedArtifact = useMemo(
    () => gallery?.artifacts.find((artifact) => artifact.key === selectedKey) ?? null,
    [gallery, selectedKey],
  );

  const activeTab: DetailTab = selectedArtifact?.kind === "script"
    ? tab === "preview" ? "source" : tab
    : tab === "requests" || ((tab === "settings" || tab === "schedule") && !gallery?.capabilities?.links) ? "preview" : tab;

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

  useEffect(() => {
    if (activeTab === "source" && selectedArtifact && resolvedVersion) setSourceVisited(`${selectedArtifact.key}:${resolvedVersion}`);
  }, [activeTab, selectedArtifact?.key, resolvedVersion]);

  const previewUrl = selectedArtifact && selectedArtifact.kind !== "script" && resolvedVersion
    ? `${artifactUrl("/gallery/preview", selectedArtifact, resolvedVersion)}&revision=${encodeURIComponent(resolvedVersion === WORKING_VERSION ? selectedArtifact.draftRevision ?? selectedArtifact.liveId ?? "" : resolvedVersion)}`
    : "";
  const downloadUrl = selectedArtifact && resolvedVersion
    ? artifactUrl("/api/source", selectedArtifact, resolvedVersion, true)
    : "";
  const exportUrl = downloadUrl ? `${downloadUrl}&format=project` : "";
  const localShareUrl = selectedArtifact && resolvedVersion
    ? new URL(resolvedVersion === WORKING_VERSION
      ? selectedArtifact.url ?? `/c/${encodeURIComponent(selectedArtifact.name)}`
      : `/gallery/preview?version=${encodeURIComponent(resolvedVersion)}`, window.location.origin).href
    : undefined;

  useEffect(() => {
    const pending = new Set<string>();
    const request = async (event: MessageEvent) => {
      const frame = previewFrame.current;
      if (!frame || event.source !== frame.contentWindow || !selectedArtifact
        || !["artifact/http-request", "artifact/plugin-request", "artifact/files-request", "artifact/file-download"].includes(event.data?.type) || typeof event.data.id !== "string"
        || event.data.id.length > 64 || (event.data.type !== "artifact/plugin-request" && typeof event.data.versionId !== "string") || pending.has(event.data.id)) return;
      const plugin = event.data.type === "artifact/plugin-request";
      const files = event.data.type === "artifact/files-request";
      const download = event.data.type === "artifact/file-download";
      const responseType = plugin ? "artifact/plugin-response" : files ? "artifact/files-response" : download ? "artifact/file-download-response" : "artifact/http-response";
      const target = frame.contentWindow!;
      const id = event.data.id;
      try {
        if (pending.size >= 16) throw new Error("Too many pending artifact requests");
        pending.add(id);
        if (download) {
          const url = artifactFileTransferUrl(event.data.url, window.location.origin);
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
        const response = await fetch(`${plugin ? "/api/plugins/call" : files ? "/api/artifact/files" : "/api/artifact/request"}?${params}`, {
          method: "POST", headers: { "content-type": "application/json" },
          // The frame selects its pinned code version, but cannot redirect a
          // request to another artifact or private/team library.
          body: JSON.stringify(plugin ? event.data.request : { name: selectedArtifact.name, version_id: event.data.versionId, request: event.data.request }),
        });
        if (redirectExpiredSession(response)) return;
        const result = await response.json() as { response?: unknown; result?: unknown; error?: string };
        if (!response.ok) throw new Error(result.error ?? `Artifact request failed (${response.status})`);
        target.postMessage({ type: responseType, id, response: result.response, result: result.result }, "*");
      } catch (error) {
        target.postMessage({ type: responseType, id, error: error instanceof Error ? error.message : String(error) }, "*");
      } finally { pending.delete(id); }
    };
    window.addEventListener("message", request);
    return () => window.removeEventListener("message", request);
  }, [selectedArtifact]);

  useEffect(() => {
    if (activeTab !== "source" || gallery?.capabilities?.links || !selectedArtifact || selectedArtifact.kind === "script" || !resolvedVersion) {
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
  }, [resolvedVersion, selectedArtifact, activeTab, gallery?.capabilities?.links]);

  useEffect(() => {
    if (activeTab === "preview") setPreviewLoading(true);
  }, [previewUrl, activeTab]);

  const selectArtifact = (artifact: GalleryArtifact) => {
    const leavingWorker = showNativeApps;
    if (!leaveWorker()) return;
    if (narrowLayout && !mobileDetail) setPreviewLoading(true);
    setMobileDetail(true);
    setShowLinks(false);
    setShowMove(false);
    setCreatingKind(null);
    setRemixing(false);
    setSelectedKey(artifact.key);
    setSelectedVersion(artifact.working ? WORKING_VERSION : [...artifact.versions].sort((a, b) => b.revision - a.revision)[0]?.id ?? null);
    const url = new URL(window.location.href);
    url.searchParams.set("name", artifact.name);
    url.searchParams.set("workspace", artifact.workspace);
    url.searchParams.set("kind", artifact.kind ?? "artifact");
    if (leavingWorker) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    navigationUrl.current = url.href;
  };

  const signOut = async () => {
    if (!workerCanLeave() || !confirmLeavingDrafts(drafts)) return;
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

  function workerCanLeave() { return workerEditor.current?.canLeave() ?? true; }
  function startCreating(kind: "artifact" | "script") {
    if (!leaveWorker()) return;
    setCreatingKind(kind);
    setTab("source");
    setShowImport(false);
    setRemixing(false);
    setShowLinks(false);
    setShowMove(false);
    setMobileDetail(true);
  }
  async function createdItem(name: string, kind: "artifact" | "script") {
    createdRemix.current = { name, kind, workspace: gallery?.workspace ?? "default" };
    await loadGallery();
    setCreatingKind(null);
    setSelectedVersion("working");
    setTab(kind === "artifact" ? "preview" : "source");
    setQuery("");
    setKindFilter("all");
  }
  function leaveWorker() {
    if (!showNativeApps) return true;
    if (!workerCanLeave()) return false;
    const url = new URL(window.location.href);
    url.searchParams.delete("view"); url.searchParams.delete("app"); url.searchParams.delete("appTab");
    window.history.pushState(null, "", url);
    navigationUrl.current = url.href;
    setSelectedWorker(null);
    return true;
  }
  function selectWorker(selection: WorkerSelection) {
    if (selection.name === selectedWorker?.name && selection.workspace === selectedWorker?.workspace) {
      setMobileDetail(true);
      return;
    }
    if (!workerCanLeave()) return;
    workerEditorKey.current++;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "workers");
    url.searchParams.set("workspace", selection.workspace);
    url.searchParams.delete("name"); url.searchParams.delete("kind");
    if (selection.name) url.searchParams.set("app", selection.name); else url.searchParams.delete("app");
    url.searchParams.set("appTab", "source");
    window.history.pushState(null, "", url);
    navigationUrl.current = url.href;
    setSelectedWorker(selection);
    setCreatingKind(null);
    setShowImport(false);
    setMobileDetail(true);
  }
  useEffect(() => {
    const navigate = () => {
      const next = workerSelection();
      const changingItem = next?.name !== selectedWorker?.name || next?.workspace !== selectedWorker?.workspace;
      if (changingItem && !workerCanLeave()) {
        window.history.pushState(null, "", navigationUrl.current);
        return;
      }
      if (changingItem) workerEditorKey.current++;
      navigationUrl.current = window.location.href;
      setSelectedWorker(next);
      if (next) setMobileDetail(true);
      else {
        const params = new URLSearchParams(window.location.search);
        const item = gallery?.artifacts.find(item => item.name === params.get("name") && item.workspace === params.get("workspace") && (item.kind ?? "artifact") === (params.get("kind") ?? "artifact"));
        if (item) setSelectedKey(item.key);
      }
    };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, [selectedWorker, gallery]);
  useEffect(() => {
    if (showNativeApps) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", activeTab);
    window.history.replaceState(null, "", url);
    navigationUrl.current = url.href;
  }, [activeTab, showNativeApps]);

  const downloadSource = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!user) return;
    event.preventDefault();
    const downloadHref = event.currentTarget.href;
    try {
      const response = await fetch(downloadHref);
      if (redirectExpiredSession(response)) return;
      if (!response.ok) throw new Error(`Source download failed (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = new URL(downloadHref).searchParams.get("format") === "project" ? `${selectedArtifact?.name ?? "artifact"}.artifact-project.json` : `${selectedArtifact?.name ?? "artifact"}${selectedArtifact?.kind === "script" ? ".ts" : ".artifact.tsx"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Could not download this source file.");
    }
  };

  return (
    <>
      <style>{galleryStyles}</style>
      <main className="gallery-app">
        <header className="app-header">
          <div className="library-heading">
            <span className="wordmark">Artifacts</span>
            <Menu.Root>
              <Menu.Trigger className="create-item" aria-label="Create or import" title="Create or import" disabled={!gallery}><span aria-hidden="true">+</span></Menu.Trigger>
              <Menu.Portal><Menu.Positioner sideOffset={6} align="end"><Menu.Popup className="action-menu">
                <Menu.Item onClick={() => startCreating("artifact")}>New artifact</Menu.Item>
                {gallery?.capabilities?.scripts ? <Menu.Item onClick={() => startCreating("script")}>New script</Menu.Item> : null}
                {gallery?.capabilities?.nativeApps ? <Menu.Item onClick={() => selectWorker({ workspace: gallery.workspace, name: null })}>New Worker app</Menu.Item> : null}
                <Menu.Item onClick={() => { if (!leaveWorker()) return; setShowImport(true); setCreatingKind(null); setMobileDetail(true); }}>Import project</Menu.Item>
              </Menu.Popup></Menu.Positioner></Menu.Portal>
            </Menu.Root>
          </div>
          {gallery?.workspace ? <span className="header-context" title={gallery.workspace}>{gallery.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? gallery.workspace}</span> : null}
          <div className="header-actions">
            <button className="theme-toggle" type="button" title={`Switch to ${theme === "light" ? "dark" : "light"} theme`} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} onClick={() => setTheme(theme === "light" ? "dark" : "light")}><span className={`theme-icon ${theme === "light" ? "moon" : "sun"}`} aria-hidden="true" /></button>
            {gallery?.libraryScope ? <Select aria-label="Library" value={gallery.libraryScope} onChange={event => {
              if (!workerCanLeave() || !confirmLeavingDrafts(drafts)) return;
              const url = new URL(window.location.href);
              url.searchParams.set("library", event.target.value);
              window.location.assign(url.href);
            }}><option value="private">Personal library</option><option value="team">Team library</option></Select> : null}
            {user ? <div className="account">
              <span className="account-name" title={user.email}>{user.name}</span>
              <button type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
            </div> : null}
          </div>
        </header>

        {galleryError && gallery ? <p role="alert" className="refresh-error error-message">Refresh failed: {galleryError}. Showing the last loaded files.</p> : null}
        {accountError ? <p role="alert" className="refresh-error error-message">{accountError}</p> : null}

        <div className="gallery-layout">
          <LibraryNavigation gallery={gallery} artifacts={filteredArtifacts} query={query} onQueryChange={setQuery}
            kindFilter={kindFilter} onKindFilterChange={setKindFilter}
            selectedKey={selectedWorker ? JSON.stringify(["worker", selectedWorker.workspace, selectedWorker.name]) : creatingKind ? null : selectedKey}
            onSelect={selectArtifact} onSelectWorker={gallery?.capabilities?.nativeApps ? selectWorker : undefined}
            isDirty={artifact => [...drafts.entries()].some(([key, draft]) => key.startsWith(artifact.key + ":") && draft.dirty)}
            loading={loading} error={galleryError} onRetry={() => void loadGallery()} connected={liveConnected}
            panelRef={libraryPanel} searchRef={searchInput} hidden={narrowLayout && mobileDetail} />

          {selectedWorker && gallery ? <NativeAppEditor ref={workerEditor} key={workerEditorKey.current} workspace={selectedWorker.workspace} appName={selectedWorker.name}
            providers={gallery.nativeAppProviders ?? []} hidden={narrowLayout && !mobileDetail} onSaved={loadGallery}
            onNavigate={name => { navigationUrl.current = window.location.href; setSelectedWorker(name ? { ...selectedWorker, name } : null); if (!name) setMobileDetail(false); }}
            onBack={() => { if (narrowLayout) setMobileDetail(false); else leaveWorker(); }} /> : null}
          {!showNativeApps ? <Tabs.Root value={activeTab} onValueChange={value => setTab(value as DetailTab)} className="artifact-detail" hidden={narrowLayout && !mobileDetail}>
            <div className="detail-header">
              <button className="back-library" type="button" onClick={() => setMobileDetail(false)} aria-label="Back to library"><span aria-hidden="true">←</span></button>
              <div className="detail-title">
                <h1 ref={detailHeading} tabIndex={-1}>{creatingKind ? `New ${creatingKind}` : selectedArtifact?.name ?? "Your artifacts"}</h1>
              </div>
            {!creatingKind && selectedArtifact && resolvedVersion ? <>
              <Tabs.List className="view-control" activateOnFocus aria-label={selectedArtifact.kind === "script" ? "Script view" : "Artifact view"}>
                {(selectedArtifact.kind === "script"
                  ? [["source", "Source"], ["requests", "Requests"]] as const
                  : [["preview", "Preview"], ["source", "Source"]] as const
                ).map(([value, label]) => <Tabs.Tab key={value} value={value}>{label}</Tabs.Tab>)}
              </Tabs.List>
            </> : null}
              {!creatingKind && selectedArtifact && resolvedVersion ? <div className="detail-actions">
                <button className="primary-action" type="button" aria-expanded={showLinks} aria-controls="link-settings-panel" onClick={() => setShowLinks(value => !value)}>Share</button>
                {selectedArtifact.kind !== "script" && selectedArtifact.url ? <a className="download-link open-link" href={selectedArtifact.url} target="_blank" rel="noopener noreferrer">Open<span aria-hidden="true">↗</span></a> : null}
                <Menu.Root>
                  <Menu.Trigger className="more-actions" aria-label="More actions"><span aria-hidden="true">⋮</span></Menu.Trigger>
                  <Menu.Portal><Menu.Positioner sideOffset={6} align="end"><Menu.Popup className="action-menu">
                    {gallery?.capabilities?.links ? <>
                      <Menu.Item onClick={() => { setTab("schedule"); setShowLinks(false); setShowMove(false); setRemixing(false); }}>Schedule</Menu.Item>
                      <Menu.Item onClick={() => { setTab("settings"); setShowLinks(false); setShowMove(false); setRemixing(false); }}>Settings</Menu.Item>
                    </> : null}
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger>Versions <span aria-hidden="true">›</span></Menu.SubmenuTrigger>
                      <Menu.Portal><Menu.Positioner sideOffset={4}><Menu.Popup className="action-menu">
                        {selectedArtifact.working ? <Menu.Item onClick={() => setSelectedVersion(WORKING_VERSION)}>Working copy</Menu.Item> : null}
                        {sortedVersions.map(version => <Menu.Item key={version.id} onClick={() => setSelectedVersion(version.id)}>Revision {version.revision} · {formatDate(version.createdAt)}</Menu.Item>)}
                      </Menu.Popup></Menu.Positioner></Menu.Portal>
                    </Menu.SubmenuRoot>
                    {gallery?.capabilities?.moves && gallery.libraryScope ? <Menu.Item onClick={() => { setShowMove(true); setShowLinks(false); setRemixing(false); }}>Move</Menu.Item> : null}
                    <Menu.Item onClick={() => { setRemixing(true); setShowMove(false); setShowLinks(false); }}>Remix</Menu.Item>
                    {selectedArtifact.kind !== "script" && selectedArtifact.url ? <Menu.Item className="mobile-open" render={<a href={selectedArtifact.url} target="_blank" rel="noopener noreferrer" />}>Open</Menu.Item> : null}
                    <Menu.Item render={<a href={exportUrl} download onClick={downloadSource} />}>Download</Menu.Item>
                  </Menu.Popup></Menu.Positioner></Menu.Portal>
                </Menu.Root>
              </div> : null}
            </div>
            {showImport && gallery ? <div className="detail-disclosure"><ProjectImportPanel workspace={gallery.workspace} hosted={!!gallery.capabilities?.links} onCancel={() => setShowImport(false)} onSaved={async (name, kind) => { createdRemix.current = { name, kind, workspace: gallery.workspace }; await loadGallery(); setSelectedVersion("working"); setTab("source"); setQuery(""); setKindFilter("all"); }} /></div> : null}

            {!creatingKind && selectedArtifact?.kind !== "script" && selectedArtifact && resolvedVersion !== "working" && gallery?.capabilities?.links ? <p className="live-data-note"><strong>Live data</strong> · Historical code uses the current database and files and can change them. Restore deploys this code while keeping current data.</p> : null}
            {showMove && !creatingKind && selectedArtifact && gallery?.libraryScope && gallery.capabilities?.moves ? <div id="library-move-panel" className="detail-disclosure"><MovePanel key={selectedArtifact.key} artifact={selectedArtifact} library={gallery.libraryScope} onCancel={() => setShowMove(false)} /></div> : null}
            {remixing && !creatingKind && selectedArtifact && resolvedVersion ? <div className="detail-disclosure"><RemixPanel key={selectedArtifact.key + resolvedVersion} artifact={selectedArtifact} version={resolvedVersion} onCancel={() => setRemixing(false)} onSaved={async name => { createdRemix.current = {name, workspace:selectedArtifact.workspace, kind:selectedArtifact.kind ?? "artifact"}; await loadGallery(); setSelectedVersion("working"); setQuery(""); setKindFilter("all"); setRemixing(false); }} /></div> : null}
            {!creatingKind && selectedArtifact && resolvedVersion ? <div id="link-settings-panel" className="detail-disclosure" hidden={!showLinks}><LinkSettings key={selectedArtifact.key} artifact={selectedArtifact} localUrl={gallery?.capabilities?.links ? undefined : localShareUrl} onSaved={loadGallery} /></div> : null}
            <Tabs.Panel value={activeTab} id="artifact-panel" className="artifact-stage" aria-label={creatingKind === "artifact" ? "Artifact source" : selectedArtifact?.kind === "script" || creatingKind === "script" ? "Script editor" : activeTab === "preview" ? "Artifact preview" : activeTab === "schedule" ? "Artifact schedule" : activeTab === "settings" ? "Artifact settings" : "Artifact source"}>
              {creatingKind === "artifact" ? <ArtifactSourcePanel key="new-artifact" workspace={gallery?.workspace ?? "default"} hosted={!!gallery?.capabilities?.links} onCancel={() => setCreatingKind(null)} onSaved={name => createdItem(name, "artifact")} />
                : creatingKind === "script" ? <ScriptPanel key="new-script" workspace={gallery?.workspace ?? "default"} onCancel={() => setCreatingKind(null)} onSaved={name => createdItem(name, "script")} />
                : selectedArtifact?.kind === "script" ? <ScriptPanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} workspace={selectedArtifact.workspace} version={resolvedVersion ?? undefined} view={activeTab as ScriptView} sourceUrl={resolvedVersion ? artifactUrl("/api/source", selectedArtifact, resolvedVersion) : undefined} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
                : !selectedArtifact && !loading && gallery?.capabilities?.links ? <AgentOnboarding workspace={gallery.workspace} />
                : !selectedArtifact ? <div className="empty-detail"><h2>{loading ? "Loading your library…" : "Your library"}</h2><p>{loading ? "Your saved artifacts will appear shortly." : "Select an artifact or script to open it."}</p></div>
                : !resolvedVersion ? <div className="empty-detail"><h2>No readable version</h2><p>This artifact has no saved source available to preview.</p></div>
                : <>
                  {activeTab === "preview" ? <div className="preview-stage">
                    {previewLoading ? <div className="preview-loading" role="status">Loading preview…</div> : null}
                    {!narrowLayout || mobileDetail ? <iframe ref={previewFrame} key={previewUrl} className="preview-frame" src={previewUrl} title={`Preview of ${selectedArtifact.name}`} sandbox="allow-scripts" onLoad={() => setPreviewLoading(false)} /> : null}
                  </div> : null}
                  {sourceVisited === `${selectedArtifact.key}:${resolvedVersion}` || activeTab === "source" ? <div className="source-stage" hidden={activeTab !== "source"}>
                    {gallery?.capabilities?.links ? <ArtifactSourcePanel key={`${selectedArtifact.key}:${resolvedVersion}`} artifact={selectedArtifact} version={resolvedVersion} sourceUrl={artifactUrl("/api/source", selectedArtifact, resolvedVersion)} onSaved={async () => { setSelectedVersion("working"); await loadGallery(); }} />
                      : source.status === "ready" ? <SourceEditor filename={`${selectedArtifact.name}.artifact.tsx`} value={source.text} onChange={() => {}} readOnly />
                      : source.status === "error" ? <p role="alert" className="state-message error-message">{source.error}</p>
                      : <p className="state-message" role="status">Loading source…</p>}
                  </div> : null}
                  {gallery?.capabilities?.links ? <div className="settings-panel" hidden={activeTab !== "settings"}><h2 className="settings-title">Secrets</h2><SecretControls key={selectedArtifact.key + "secrets"} workspace={selectedArtifact.workspace} name={selectedArtifact.name} kind="artifact" /></div> : null}
                  {gallery?.capabilities?.links ? <div id="execution-panel" className="artifact-execution" hidden={activeTab !== "schedule"}><ExecutionControls key={selectedArtifact.key + "execution"} workspace={selectedArtifact.workspace} name={selectedArtifact.name} kind="artifact" active={activeTab === "schedule"} /></div> : null}
                </>}
            </Tabs.Panel>
          </Tabs.Root> : null}
        </div>
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<DraftProvider><App /></DraftProvider>);
