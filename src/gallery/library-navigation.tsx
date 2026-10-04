import { useRef, type ReactNode, type RefObject } from "react";
import { ArtifactFolders } from "./folders";
import type { GalleryArtifact, GalleryData, GalleryItem, GalleryWorker } from "./types";

export type LibraryKindFilter = "all" | "artifact" | "script" | "worker";

/** Shared navigation for the web gallery and the chat workspace. */
export function LibraryNavigation({ gallery, artifacts, query, onQueryChange, kindFilter, onKindFilterChange,
  selectedKey, onSelect, onSelectWorker, isDirty, loading, error, onRetry, connected = true, panelRef, searchRef, hidden, footer,
}: {
  gallery: GalleryData | null; artifacts: GalleryItem[]; query: string; onQueryChange: (query: string) => void;
  kindFilter: LibraryKindFilter; onKindFilterChange: (kind: LibraryKindFilter) => void;
  selectedKey: string | null; onSelect: (artifact: GalleryArtifact) => void; onSelectWorker?: (worker: GalleryWorker) => void; isDirty: (artifact: GalleryItem) => boolean;
  loading: boolean; error?: string; onRetry: () => void; connected?: boolean;
  panelRef?: RefObject<HTMLElement | null>; searchRef?: RefObject<HTMLInputElement | null>; hidden?: boolean; footer?: ReactNode;
}) {
  const localSearch = useRef<HTMLInputElement>(null);
  const input = searchRef ?? localSearch;
  const workers = !!onSelectWorker;
  const libraryItems = [...(gallery?.artifacts ?? []), ...(workers ? gallery?.workerApps ?? [] : [])];
  return <aside ref={panelRef} className="library-panel" hidden={hidden} aria-label={workers ? "Artifacts library" : gallery?.capabilities?.scripts ? "Artifacts and scripts" : "Artifacts"}>
    {!connected ? <p className="connection-status" role="status">Reconnecting to live updates…</p> : null}
    <div className="library-search">
      <input ref={input} className="search-input" type="search"
        aria-label={workers ? "Search library" : gallery?.capabilities?.scripts ? "Search artifacts and scripts" : "Search artifacts"}
        value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search"
        autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore />
      {query ? <button type="button" className="clear-search" aria-label="Clear search" onClick={() => { onQueryChange(""); input.current?.focus(); }}><span aria-hidden="true">×</span></button> : null}
    </div>
    {gallery?.capabilities?.scripts || workers ? <div className="library-filters" role="group" aria-label="Filter library">
      {([['all', 'All'], ['artifact', 'Artifacts'], ...(gallery?.capabilities?.scripts ? [['script', 'Scripts']] : []), ...(workers ? [['worker', 'Workers']] : [])] as [LibraryKindFilter, string][]).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={kindFilter === value} onClick={() => onKindFilterChange(value)}>{label}</button>)}
    </div> : null}
    <div className="artifact-list" aria-busy={loading}>
      {loading && !gallery ? <p className="state-message" role="status">Loading library…</p>
        : error && !gallery ? <div role="alert" className="library-empty"><p className="error-message">{error}</p><button type="button" onClick={onRetry}>Try again</button></div>
        : artifacts.length === 0 ? <div className="library-empty">
          <p>{loading ? "Searching…" : query ? "No matches" : kindFilter !== "all" ? `No ${kindFilter === "script" ? "scripts" : kindFilter === "worker" ? "Worker apps" : "artifacts"}` : "Your library is empty"}</p>
          {query || kindFilter !== "all" ? <button type="button" onClick={() => { onQueryChange(""); onKindFilterChange("all"); }}>Show all items</button> : <p>Saved artifacts will appear here.</p>}
        </div>
        : <ArtifactFolders artifacts={artifacts} workspaces={[...new Set(libraryItems.map(item => item.workspace))]} searching={!!query} renderArtifact={(artifact, depth) => <button className="artifact-row" style={{ paddingLeft: depth * 14 + 10 }} type="button" key={artifact.key}
          title={`${artifact.workspace}/${artifact.name}`} aria-current={artifact.key === selectedKey ? "true" : undefined}
          onClick={() => artifact.kind === "worker" ? onSelectWorker?.(artifact) : onSelect(artifact)} onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest" })}>
          <span className="file-icon" aria-hidden="true" />
          <span className="artifact-row-copy"><span className="artifact-name">{artifact.name}</span>
            {isDirty(artifact) ? <span className="workspace-name">Unsaved changes</span> : null}
            {artifact.kind === "worker" ? <span className="workspace-name">{artifact.status.replaceAll("-", " ")}</span> : !artifact.working ? <span className="workspace-name">Archived</span> : null}
          </span>
          {artifact.kind === "script" ? <span className="row-kind">Script</span> : artifact.kind === "worker" ? <span className="row-kind">Worker</span> : null}
        </button>} />}
    </div>
    {query || kindFilter !== "all" ? <div className="library-count">{artifacts.length} of {libraryItems.length} items</div> : null}
    {footer ? <div className="library-footer">{footer}</div> : null}
  </aside>;
}
