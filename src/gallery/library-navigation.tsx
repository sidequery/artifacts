import { useRef, type ReactNode, type RefObject } from "react";
import { ArtifactFolders } from "./folders";
import type { GalleryArtifact, GalleryData } from "./types";

export type LibraryKindFilter = "all" | "artifact" | "script";

/** Shared navigation for the web gallery and the chat workspace. */
export function LibraryNavigation({ gallery, artifacts, query, onQueryChange, kindFilter, onKindFilterChange,
  selectedKey, onSelect, isDirty, loading, error, onRetry, connected = true, panelRef, searchRef, hidden, footer,
}: {
  gallery: GalleryData | null; artifacts: GalleryArtifact[]; query: string; onQueryChange: (query: string) => void;
  kindFilter: LibraryKindFilter; onKindFilterChange: (kind: LibraryKindFilter) => void;
  selectedKey: string | null; onSelect: (artifact: GalleryArtifact) => void; isDirty: (artifact: GalleryArtifact) => boolean;
  loading: boolean; error?: string; onRetry: () => void; connected?: boolean;
  panelRef?: RefObject<HTMLElement | null>; searchRef?: RefObject<HTMLInputElement | null>; hidden?: boolean; footer?: ReactNode;
}) {
  const localSearch = useRef<HTMLInputElement>(null);
  const input = searchRef ?? localSearch;
  return <aside ref={panelRef} className="library-panel" hidden={hidden} aria-label={gallery?.capabilities?.scripts ? "Artifacts and scripts" : "Artifacts"}>
    {!connected ? <p className="connection-status" role="status">Reconnecting to live updates…</p> : null}
    <div className="library-search">
      <input ref={input} className="search-input" type="search"
        aria-label={gallery?.capabilities?.scripts ? "Search artifacts and scripts" : "Search artifacts"}
        value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search"
        autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore />
      {query ? <button type="button" className="clear-search" aria-label="Clear search" onClick={() => { onQueryChange(""); input.current?.focus(); }}><span aria-hidden="true">×</span></button> : null}
    </div>
    {gallery?.capabilities?.scripts ? <div className="library-filters" role="group" aria-label="Filter library">
      {([['all', 'All'], ['artifact', 'Artifacts'], ['script', 'Scripts']] as const).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={kindFilter === value} onClick={() => onKindFilterChange(value)}>{label}</button>)}
    </div> : null}
    <div className="artifact-list" aria-busy={loading}>
      {loading && !gallery ? <p className="state-message" role="status">Loading library…</p>
        : error && !gallery ? <div role="alert" className="library-empty"><p className="error-message">{error}</p><button type="button" onClick={onRetry}>Try again</button></div>
        : artifacts.length === 0 ? <div className="library-empty">
          <p>{loading ? "Searching…" : query ? "No matches" : kindFilter !== "all" ? `No ${kindFilter === "script" ? "scripts" : "artifacts"}` : "Your library is empty"}</p>
          {query || kindFilter !== "all" ? <button type="button" onClick={() => { onQueryChange(""); onKindFilterChange("all"); }}>Show all items</button> : <p>Saved artifacts will appear here.</p>}
        </div>
        : <ArtifactFolders artifacts={artifacts} workspaces={[...new Set((gallery?.artifacts ?? []).map(item => item.workspace))]} searching={!!query} renderArtifact={(artifact, depth) => <button className="artifact-row" style={{ paddingLeft: depth * 14 + 10 }} type="button" key={artifact.key}
          title={`${artifact.workspace}/${artifact.name}`} aria-current={artifact.key === selectedKey ? "true" : undefined}
          onClick={() => onSelect(artifact)} onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest" })}>
          <span className="file-icon" aria-hidden="true" />
          <span className="artifact-row-copy"><span className="artifact-name">{artifact.name}</span>
            {isDirty(artifact) ? <span className="workspace-name">Unsaved changes</span> : null}
            {!artifact.working ? <span className="workspace-name">Archived</span> : null}
          </span>
          {artifact.kind === "script" ? <span className="row-kind">Script</span> : null}
        </button>} />}
    </div>
    <div className="library-footer">{query || kindFilter !== "all" ? `${artifacts.length} of ${gallery?.artifacts.length ?? 0} items` : null}
      {gallery?.capabilities?.scripts ? <details><summary>Artifacts and scripts</summary><p>Artifacts are interactive apps with a UI and optional backend. Scripts are HTTP handlers that return a response when their URL is called.</p><p>Both have source files, dependencies, history, and their own URL.</p></details> : null}
      {footer}
    </div>
  </aside>;
}
