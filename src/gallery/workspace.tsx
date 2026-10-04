import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { Menu } from "@base-ui/react/menu";
import { DraftProvider, useDrafts, type SourceSnapshot } from "./drafts";
import { ArtifactSourcePanel, LinkSettings, ScriptPanel, type ScriptView } from "./hosted";
import { LibraryNavigation, type LibraryKindFilter } from "./library-navigation";
import { ProjectEditor } from "./project-editor";
import { RemixPanel } from "./remix";
import { Select } from "./select";
import { galleryStyles } from "./styles";
import { GalleryTransportProvider, useGalleryTransport, type GalleryTransport } from "./transport";
import type { GalleryArtifact, GalleryData } from "./types";

export type WorkspaceSelection = { name?: string; workspace?: string; kind?: "artifact" | "script"; version_id?: string; route?: string; tab?: "preview" | "source" };
export type GalleryWorkspaceProps = {
  initial: GalleryData;
  view: "library" | "working";
  transport: GalleryTransport;
  search: (query: string, offset: number) => Promise<GalleryData>;
  renderPreview: (container: HTMLElement, artifact: GalleryArtifact, version: string, route?: string) => Promise<() => void>;
  attach: (artifact: GalleryArtifact, version: string) => Promise<void>;
  attachedVersionId?: string;
  selection?: WorkspaceSelection;
  onSelectionChange?: (selection: WorkspaceSelection) => void;
  openProduct?: () => Promise<void>;
  openLink?: (url: string) => Promise<void>;
  askCreate?: () => Promise<void>;
  refreshKey?: number;
};

/** Catalog pages may contain different revisions of the same project. */
export function mergeGalleryItems(previous: GalleryArtifact[], incoming: GalleryArtifact[]): GalleryArtifact[] {
  const items = new Map(previous.map(item => [item.key, item]));
  for (const item of incoming) {
    const before = items.get(item.key);
    const versions = new Map([...(before?.versions ?? []), ...item.versions].map(version => [version.id, version]));
    items.set(item.key, { ...before, ...item, working: item.working || !!before?.working, versions: [...versions.values()].sort((a, b) => b.revision - a.revision) });
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace));
}

export function selectedGalleryArtifact(items: GalleryArtifact[], selection?: WorkspaceSelection): GalleryArtifact | undefined {
  if (!selection) return undefined;
  return items.find(item => (!selection.workspace || item.workspace === selection.workspace)
    && (!selection.kind || (item.kind ?? "artifact") === selection.kind)
    && (selection.version_id ? item.versions.some(version => version.id === selection.version_id) : item.name === selection.name));
}

/** Finish pagination even when a filtered page contains no matching items. */
export async function readWorkspaceCatalog(search: GalleryWorkspaceProps["search"], query: string, isCurrent: () => boolean = () => true): Promise<GalleryData | undefined> {
  let offset = 0;
  let items: GalleryArtifact[] = [];
  let page: GalleryData;
  do {
    page = await search(query, offset);
    if (!isCurrent()) return;
    items = mergeGalleryItems(items, page.artifacts);
    if (page.nextOffset == null) break;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid library pagination.");
    offset = page.nextOffset;
  } while (true);
  return { ...page, artifacts: items, nextOffset: null };
}

export function workspaceSourceUrl(artifact: GalleryArtifact, version: string): string {
  const params = new URLSearchParams({ workspace: artifact.workspace });
  if (version === "working") params.set("name", artifact.name);
  else params.set("version_id", version);
  if (artifact.kind === "script") params.set("kind", "script");
  return `/api/source?${params}`;
}

function currentVersion(artifact: GalleryArtifact): string | null {
  return artifact.working ? "working" : [...artifact.versions].sort((a, b) => b.revision - a.revision)[0]?.id ?? null;
}

/** A pinned revision remains pinned even when a refreshed catalog is incomplete. */
export function resolveWorkspaceVersion(artifact: GalleryArtifact, requested: string | null): string | null {
  return requested ?? currentVersion(artifact);
}

function ReadOnlyProject({ artifact, version }: { artifact: GalleryArtifact; version: string }) {
  const { loadSource } = useGalleryTransport();
  const [snapshot, setSnapshot] = useState<SourceSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined); setError("");
    void loadSource(workspaceSourceUrl(artifact, version), controller.signal).then(value => {
      if (!controller.signal.aborted) setSnapshot(value);
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [artifact.key, artifact.draftRevision, version, loadSource]);
  if (error) return <p role="alert" className="state-message error-message">{error}</p>;
  if (!snapshot) return <p role="status" className="state-message">Loading source…</p>;
  return <div className="script-panel source-form"><ProjectEditor entries={[
    { id: "client", filename: artifact.kind === "script" ? "script.ts" : `${artifact.name}.artifact.tsx`, source: snapshot.source },
    ...(snapshot.server_source == null ? [] : [{ id: "server", filename: `${artifact.name}.artifact.server.ts`, source: snapshot.server_source }]),
  ]} project={snapshot.project} onProjectChange={() => {}} onEntryChange={() => {}} onValidityChange={() => {}} readOnly />
    <div className="source-actions"><span className="muted">Read-only source · Edit this project in its connected workspace.</span></div>
  </div>;
}

function Preview({ artifact, version, route, render, refresh }: {
  artifact: GalleryArtifact; version: string; route?: string; render: GalleryWorkspaceProps["renderPreview"]; refresh: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setLoading(true); setError("");
    void render(container.current!, artifact, version, route).then(cleanup => {
      if (cancelled) cleanup();
      else { dispose = cleanup; setLoading(false); }
    }).catch(error => { if (!cancelled) { setError(String(error)); setLoading(false); } });
    return () => { cancelled = true; dispose?.(); };
  }, [artifact.key, artifact.draftRevision, version, route, render, refresh]);
  return <div className="preview-stage">
    {loading ? <p className="preview-loading" role="status">Loading preview…</p> : null}
    {error ? <p className="state-message error-message" role="alert">{error}</p> : null}
    <div ref={container} className="workspace-preview" />
  </div>;
}

export function GalleryWorkspace(props: GalleryWorkspaceProps) {
  return <GalleryTransportProvider transport={props.transport}><DraftProvider><Workspace {...props} /></DraftProvider></GalleryTransportProvider>;
}

function Workspace({ initial, view, search, renderPreview, attach, attachedVersionId, selection, onSelectionChange, openProduct, openLink, askCreate, refreshKey }: GalleryWorkspaceProps) {
  const { drafts } = useDrafts();
  const initialSelection = selectedGalleryArtifact(initial.artifacts, selection);
  const [gallery, setGallery] = useState(initial);
  const [catalog, setCatalog] = useState(initial.artifacts);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<LibraryKindFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelection?.key ?? (view === "library" && !selection ? initial.artifacts[0]?.key ?? null : null));
  const [version, setVersion] = useState<string | null>(selection?.version_id ?? null);
  const [route, setRoute] = useState(selection?.route ?? "/");
  const [tab, setTab] = useState<"preview" | ScriptView>(selection?.tab ?? "preview");
  const [sourceVisited, setSourceVisited] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(view === "library");
  const [mobileDetail, setMobileDetail] = useState(!!initialSelection || view === "working");
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [disclosure, setDisclosure] = useState<"share" | "remix" | null>(null);
  const [selectionLookup, setSelectionLookup] = useState<{ key: string; state: "loading" | "missing" | "error" }>();
  const searchGeneration = useRef(0);
  const lookupGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selectionKey = JSON.stringify(selection ?? null);
  const appliedSelection = useRef<string | undefined>(undefined);
  const lastRefreshKey = useRef(refreshKey);
  const activeSelection = useRef(selectedKey);
  activeSelection.current = selectedKey;
  const currentQuery = useRef(query);
  currentQuery.current = query;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const changed = () => setNarrow(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    setCatalog(previous => mergeGalleryItems(previous, initial.artifacts));
    if (!query) setGallery(initial);
  }, [initial]);
  useEffect(() => { setNotice(""); }, [attachedVersionId]);
  useEffect(() => {
    if (!selection || appliedSelection.current === selectionKey) return;
    const item = selectedGalleryArtifact(catalog, selection);
    if (!item) return;
    appliedSelection.current = selectionKey;
    setDisclosure(null);
    setSelectedKey(item.key); setVersion(selection.version_id ?? currentVersion(item));
    setRoute(selection.route ?? "/"); setTab(selection.tab ?? (item.kind === "script" ? "source" : "preview"));
    setMobileDetail(true); if (view === "working") setChoosing(false);
  }, [catalog, selectionKey, view]);
  useEffect(() => {
    if (!selection || appliedSelection.current === selectionKey || selectedGalleryArtifact(catalog, selection)) return;
    const generation = ++lookupGeneration.current;
    setSelectedKey(null); setMobileDetail(true); setDisclosure(null);
    setSelectionLookup({ key: selectionKey, state: "loading" });
    void readWorkspaceCatalog(search, "", () => generation === lookupGeneration.current).then(page => {
      if (!page || generation !== lookupGeneration.current) return;
      setCatalog(previous => mergeGalleryItems(previous, page.artifacts));
      if (!currentQuery.current) setGallery(page);
      const found = selectedGalleryArtifact(page.artifacts, selection);
      setSelectionLookup(found ? undefined : { key: selectionKey, state: "missing" });
    }).catch(error => {
      if (generation !== lookupGeneration.current) return;
      setError(error instanceof Error ? error.message : String(error));
      setSelectionLookup({ key: selectionKey, state: "error" });
    });
    return () => { if (generation === lookupGeneration.current) ++lookupGeneration.current; };
  }, [selectionKey, search]);

  const load = useCallback(async (searchQuery: string) => {
    const generation = ++searchGeneration.current;
    setLoading(true); setError("");
    try {
      const page = await readWorkspaceCatalog(search, searchQuery, () => generation === searchGeneration.current);
      if (!page) return;
      setGallery(page);
      setCatalog(previous => mergeGalleryItems(previous, page.artifacts));
      return page;
    } catch (error) {
      if (generation === searchGeneration.current) setError(error instanceof Error ? error.message : String(error));
    } finally { if (generation === searchGeneration.current) setLoading(false); }
  }, [search]);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    setRefresh(value => value + 1);
    void load(query);
  }, [refreshKey, load, query]);
  useEffect(() => {
    if (!choosing) return;
    if (selection && appliedSelection.current !== selectionKey && !selectedGalleryArtifact(catalog, selection)) return;
    const timer = setTimeout(() => void load(query), 150);
    return () => { clearTimeout(timer); ++searchGeneration.current; };
  }, [query, choosing, load]);
  useEffect(() => () => { ++searchGeneration.current; }, []);

  const artifact = catalog.find(item => item.key === selectedKey);
  const resolvedVersion = artifact ? resolveWorkspaceVersion(artifact, version) : null;
  const activeTab = artifact?.kind === "script" && tab === "preview" ? "source" : artifact?.kind !== "script" && tab === "requests" ? "preview" : tab;
  const versions = useMemo(() => [...(artifact?.versions ?? [])].sort((a, b) => b.revision - a.revision), [artifact]);
  const filtered = gallery.artifacts.filter(item => (kindFilter === "all" || (item.kind ?? "artifact") === kindFilter)
    && (!query || `${item.name}\n${item.workspace}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const detailId = artifact && resolvedVersion ? `${artifact.key}:${resolvedVersion}` : null;
  useEffect(() => { if (activeTab === "source") setSourceVisited(detailId); }, [activeTab, detailId]);
  useEffect(() => { if (mobileDetail) headingRef.current?.focus(); }, [mobileDetail]);
  const notifySelection = (item: GalleryArtifact, selectedVersion: string, selectedRoute = "/", selectedTab = activeTab) => {
    onSelectionChange?.({ workspace: item.workspace, kind: item.kind ?? "artifact", ...(selectedVersion === "working" ? { name: item.name } : { version_id: selectedVersion }), route: selectedRoute, tab: selectedTab === "preview" ? "preview" : "source" });
  };
  function selectArtifact(item: GalleryArtifact, preferredTab?: "preview" | "source") {
    ++lookupGeneration.current;
    appliedSelection.current = selectionKey;
    setSelectionLookup(undefined); setDisclosure(null);
    const nextVersion = currentVersion(item);
    setSelectedKey(item.key); setVersion(nextVersion); setRoute("/"); setNotice("");
    const nextTab = preferredTab ?? (item.kind === "script" ? "source" : "preview");
    setTab(nextTab); setMobileDetail(true);
    if (view === "working") setChoosing(false);
    if (nextVersion) notifySelection(item, nextVersion, "/", nextTab);
  }
  function chooseLibrary() {
    ++lookupGeneration.current;
    appliedSelection.current = selectionKey;
    setSelectionLookup(undefined); setChoosing(true); setMobileDetail(false);
    if (choosing) void load(query);
  }
  async function perform(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  async function saved() {
    if (artifact && activeSelection.current === artifact.key) {
      setVersion("working"); setRefresh(value => value + 1);
      notifySelection(artifact, "working", route);
    }
    await load(query);
  }
  const showLibrary = choosing && (!narrow || !mobileDetail);
  const showDetail = !narrow || mobileDetail || !choosing;
  const attachedRevision = artifact?.versions.find(item => item.id === attachedVersionId);
  const editing = gallery.capabilities?.editing === true;
  const findingSelection = !!selection && !artifact && appliedSelection.current !== selectionKey
    && (!selectionLookup || selectionLookup.key !== selectionKey || selectionLookup.state === "loading");

  return <>
    <style>{galleryStyles}{workspaceStyles}</style>
    <main className="gallery-app mcp-gallery" data-view={view}>
      <header className="app-header">
        <span className="wordmark">Artifacts</span>
        <span className="header-context">{view === "working" ? "This conversation" : gallery.libraryScope === "team" ? "Team library" : "Library"}</span>
        <div className="header-actions">
          {view === "working" ? <button type="button" onClick={chooseLibrary}>Choose from library</button> : null}
          {gallery.capabilities?.nativeApps && openProduct ? <button type="button" onClick={() => void perform(openProduct)}>Worker apps<span aria-hidden="true">↗</span></button> : null}
          {openProduct ? <button type="button" onClick={() => void perform(openProduct)}>Open library<span aria-hidden="true">↗</span></button> : null}
        </div>
      </header>
      {error ? <p role="alert" className="refresh-error error-message">{error}</p> : null}
      {notice ? <p role="status" className="workspace-notice">{notice}</p> : null}
      <div className={`gallery-layout${!choosing ? " workspace-focused" : ""}`}>
        <LibraryNavigation gallery={gallery} artifacts={filtered} query={query} onQueryChange={setQuery}
          kindFilter={kindFilter} onKindFilterChange={setKindFilter} selectedKey={selectedKey} onSelect={selectArtifact}
          isDirty={item => [...drafts.entries()].some(([key, draft]) => key.startsWith(`${item.key}:`) && draft.dirty)}
          loading={loading} error={error} onRetry={() => void load(query)} searchRef={searchRef} hidden={!showLibrary}
          footer={<button type="button" disabled={loading} onClick={() => void load(query)}>Refresh library</button>} />
        <Tabs.Root value={activeTab} onValueChange={value => setTab(value as typeof tab)} className="artifact-detail" hidden={!showDetail}>
          <div className="detail-header">
            <button className="back-library" type="button" onClick={chooseLibrary} aria-label="Back to library"><span aria-hidden="true">←</span></button>
            <div className="detail-title"><h1 ref={headingRef} tabIndex={-1}>{artifact?.name ?? (view === "working" ? "Working artifact" : "Your library")}</h1></div>
            {artifact && resolvedVersion ? <Tabs.List className="view-control" activateOnFocus aria-label={artifact.kind === "script" ? "Script view" : "Artifact view"}>
              {(artifact.kind === "script" ? [["source", "Source"], ...(editing ? [["requests", "Requests"]] : [])] : [["preview", "Preview"], ["source", "Source"]]).map(([value, label]) => <Tabs.Tab key={value} value={value}>{label}</Tabs.Tab>)}
            </Tabs.List> : null}
            {artifact && resolvedVersion && (gallery.capabilities?.links || editing) ? <div className="detail-actions"><Menu.Root>
              <Menu.Trigger className="more-actions" aria-label="More actions"><span aria-hidden="true">⋮</span></Menu.Trigger>
              <Menu.Portal><Menu.Positioner sideOffset={6} align="end"><Menu.Popup className="action-menu">
                {gallery.capabilities?.links ? <Menu.Item onClick={() => setDisclosure("share")}>Share</Menu.Item> : null}
                {editing ? <Menu.Item onClick={() => setDisclosure("remix")}>Remix</Menu.Item> : null}
              </Menu.Popup></Menu.Positioner></Menu.Portal>
            </Menu.Root></div> : null}
          </div>
          {artifact && resolvedVersion ? <div className="workspace-item-bar">
            <span className="workspace-item-location" title={artifact.workspace}>{artifact.workspace}</span>
            <Select aria-label={`Revision of ${artifact.name}`} value={resolvedVersion} onChange={event => {
              setVersion(event.target.value); setNotice(""); setDisclosure(null); notifySelection(artifact, event.target.value, route);
            }}>
              {artifact.working ? <option value="working">Working copy</option> : null}
              {resolvedVersion === "working" && !artifact.working ? <option value="working">Working copy unavailable</option> : null}
              {resolvedVersion !== "working" && !versions.some(item => item.id === resolvedVersion) ? <option value={resolvedVersion}>Selected revision</option> : null}
              {versions.map(item => <option key={item.id} value={item.id}>Revision {item.revision} · {new Date(item.createdAt).toLocaleDateString()}</option>)}
            </Select>
            <button type="button" disabled={loading} onClick={() => { setRefresh(value => value + 1); void load(query); }}>Refresh</button>
            {artifact.kind !== "script" ? <button type="button" className="primary-action" disabled={attaching} onClick={() => {
              setAttaching(true); void perform(async () => { await attach(artifact, resolvedVersion); setNotice("Artifact context added to this conversation."); }).finally(() => setAttaching(false));
            }}>{attaching ? "Attaching…" : attachedVersionId === resolvedVersion ? "Update conversation context" : "Use in conversation"}</button> : null}
            {attachedRevision ? <span className="workspace-attachment" role="status">Revision {attachedRevision.revision} attached</span> : attachedVersionId === resolvedVersion ? <span className="workspace-attachment" role="status">Revision attached</span> : null}
          </div> : null}
          {artifact && resolvedVersion && disclosure === "share" ? <div className="detail-disclosure">
            <div className="workspace-disclosure-header"><strong>Share {artifact.name}</strong><button type="button" onClick={() => setDisclosure(null)} aria-label="Close sharing settings">Close</button></div>
            <LinkSettings key={artifact.key} artifact={artifact} onSaved={async () => { await load(query); }} openLink={openLink} />
          </div> : null}
          {artifact && resolvedVersion && disclosure === "remix" ? <div className="detail-disclosure">
            <RemixPanel key={detailId} artifact={artifact} version={resolvedVersion} onCancel={() => setDisclosure(null)} onSaved={async name => {
              const page = await load("");
              setQuery(""); setKindFilter("all");
              const created = page?.artifacts.find(item => item.name === name && item.workspace === artifact.workspace && (item.kind ?? "artifact") === (artifact.kind ?? "artifact"));
              if (created) selectArtifact(created, "source");
              else { setDisclosure(null); setNotice(`Created ${name}. Refresh the library to open it.`); }
            }} />
          </div> : null}
          {artifact && resolvedVersion !== "working" && gallery.capabilities?.links && artifact.kind !== "script" ? <p className="live-data-note"><strong>Live data</strong> · Historical code uses the current database and files and can change them. Restore deploys this code while keeping current data.</p> : null}
          <Tabs.Panel value={activeTab} className="artifact-stage" aria-label={activeTab === "preview" ? "Artifact preview" : activeTab === "requests" ? "Script requests" : "Artifact source"}>
            {!artifact ? <div className="empty-detail">
              <h2>{findingSelection ? "Opening selected artifact…" : selectionLookup?.key === selectionKey && selectionLookup.state === "missing" ? "Artifact unavailable" : view === "working" ? "Choose an artifact for this conversation" : "Your library"}</h2>
              <p role={findingSelection ? "status" : undefined}>{findingSelection ? "Searching the accessible library for this artifact and revision." : selectionLookup?.key === selectionKey && selectionLookup.state === "missing" ? "This artifact or revision is missing or you no longer have access. Choose an accessible item to continue." : selectionLookup?.key === selectionKey && selectionLookup.state === "error" ? "The library could not be loaded. Choose from the library to retry." : view === "working" ? "Open an artifact from your library, then choose Use in conversation to share its context." : "Select an artifact or script to open its preview, source, and history."}</p>
              {view === "working" ? <button type="button" className="primary-action" onClick={chooseLibrary}>Choose from library</button> : null}
              {askCreate ? <button type="button" onClick={() => void perform(askCreate)}>Create with your assistant</button> : null}
            </div>
              : !resolvedVersion ? <div className="empty-detail"><h2>No readable version</h2><p>This item has no saved source available.</p></div>
              : <>
                {artifact.kind !== "script" && activeTab === "preview" ? <Preview artifact={artifact} version={resolvedVersion} route={route} render={renderPreview} refresh={refresh} /> : null}
                {artifact.kind === "script" && editing ? <ScriptPanel key={detailId} artifact={artifact} workspace={artifact.workspace} version={resolvedVersion} view={activeTab as ScriptView} sourceUrl={workspaceSourceUrl(artifact, resolvedVersion)} onSaved={saved} />
                  : sourceVisited === detailId || activeTab === "source" ? <div className="source-stage" hidden={activeTab !== "source"}>
                    {editing ? <ArtifactSourcePanel key={detailId} artifact={artifact} version={resolvedVersion} sourceUrl={workspaceSourceUrl(artifact, resolvedVersion)} onSaved={saved} /> : <ReadOnlyProject key={detailId} artifact={artifact} version={resolvedVersion} />}
                  </div> : null}
              </>}
          </Tabs.Panel>
        </Tabs.Root>
      </div>
    </main>
  </>;
}

const workspaceStyles = `
  .mcp-gallery { height: 100%; min-height: 360px; }
  .mcp-gallery .workspace-focused { grid-template-columns: minmax(0, 1fr); }
  .mcp-gallery .detail-header { flex-wrap: wrap; }
  .workspace-item-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .workspace-item-location { color: var(--muted); font-size: 12px; flex: 1; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-item-bar .select-control { max-width: 230px; }
  .workspace-attachment { font-size: 12px; color: var(--muted); }
  .workspace-notice { padding: 4px 16px; margin: 0; color: var(--muted); }
  .workspace-disclosure-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 0; }
  .workspace-preview { flex: 1; width: 100%; height: 100%; min-height: 0; }
  .workspace-preview iframe { display: block; width: 100%; height: 100%; border: 0; }
  .mcp-gallery .empty-detail button { margin: 8px 4px; }
  @media (max-width: 760px) {
    .workspace-item-bar { padding: 8px; gap: 4px; }
    .workspace-item-location { flex-basis: 100%; }
    .mcp-gallery .header-context { display: inline; }
    .mcp-gallery .wordmark { width: auto; }
  }
`;
