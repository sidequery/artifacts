import { useEffect, useRef, useState } from "react";
import { GalleryToolError, galleryTool } from "./hosted";
import { ProjectEditor, editableProject, emptyEditableProject, type EditableProject } from "./project-editor";
import { SecretControls } from "./secrets";
import { Select } from "./select";

type App = { name: string; provider: string; status: string; error?: string; active_revision?: string; desired_revision?: string; revision_token: string };
type Snapshot = App & { source: string; manifest: { main: string }; project: EditableProject };
const initialManifest = { main: "worker.ts", compatibility_date: "2026-09-06", compatibility_flags: ["nodejs_compat"], vars: {}, secrets: [], bindings: {}, triggers: { crons: [], queues: [] } };
const initialSource = 'export default { fetch(request: Request) { return new Response("Hello from your Worker"); } };';
const decode = <T,>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export function NativeAppsPanel({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [apps, setApps] = useState<App[]>([]), [providers, setProviders] = useState<string[]>([]);
  const [selected, setSelected] = useState<App | null>(null), [name, setName] = useState("");
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [provider, setProvider] = useState(""), [source, setSource] = useState(initialSource);
  const [manifest, setManifest] = useState(JSON.stringify(initialManifest, null, 2));
  const [project, setProject] = useState(emptyEditableProject), [dependencies, setDependencies] = useState("{}");
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [valid, setValid] = useState(true);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const [revisions, setRevisions] = useState<{ id: string; created_at: string }[]>([]), [restoreId, setRestoreId] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const library = new URLSearchParams(window.location.search).get("library") === "team" ? "team" : "private";
  const allowLeave = () => !dirty || window.confirm("Discard unsaved Worker app changes?");
  async function loadList() {
    let offset = 0;
    const rows: App[] = [];
    for (;;) {
      const page = decode<{ apps: App[]; providers: string[]; next_offset: number | null }>(await galleryTool(workspace, "app_list", { offset }));
      rows.push(...page.apps); setProviders(page.providers); setProvider(value => value || page.providers[0] || "");
      if (page.next_offset === null) break;
      if (page.next_offset <= offset) throw new Error("Invalid app pagination");
      offset = page.next_offset;
    }
    setApps(rows);
  }
  useEffect(() => {
    dialog.current?.showModal();
    void loadList().catch(error => setError(String(error)));
  }, [workspace]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  async function perform(action: () => Promise<void>, editorMatchesDraft = false) {
    setBusy(true); setError(""); setStatus("");
    try { await action(); }
    catch (error) {
      if (error instanceof GalleryToolError && error.result?.applied) {
        if (editorMatchesDraft) {
          setDirty(false); setSelected(error.result as App); setBaseRevision(error.result.revision_token ?? null);
        } else await loadApp(name);
        await loadList();
      }
      const diagnostics = error instanceof GalleryToolError ? error.result?.diagnostics : undefined;
      setError(diagnostics?.length ? diagnostics.map(item => item.message).join("\n") : error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }
  async function loadApp(name: string) {
    const saved = decode<Snapshot>(await galleryTool(workspace, "app_read", { name }));
    setSelected(saved); setBaseRevision(saved.revision_token); setName(saved.name); setProvider(saved.provider); setSource(saved.source);
    setManifest(JSON.stringify(saved.manifest, null, 2)); setProject(editableProject(saved.project));
    setDependencies(JSON.stringify(saved.project.dependencies, null, 2)); setDirty(false); setEditorKey(value => value + 1);
    let offset = 0;
    const revisions: { id: string; created_at: string }[] = [];
    for (;;) {
      const history = decode<{ revisions: { id: string; created_at: string }[]; next_offset: number | null }>(await galleryTool(workspace, "app_history", { name, offset }));
      revisions.push(...history.revisions);
      if (history.next_offset === null) break;
      if (history.next_offset <= offset) throw new Error("Invalid app history pagination");
      offset = history.next_offset;
    }
    setRevisions(revisions); setRestoreId(revisions[0]?.id ?? "");
  }
  function newApp() {
    if (!allowLeave()) return;
    setSelected(null); setBaseRevision(null); setName(""); setSource(initialSource); setManifest(JSON.stringify(initialManifest, null, 2));
    setProject(emptyEditableProject()); setDependencies("{}"); setRevisions([]); setProvider(providers[0] ?? "");
    setDirty(false); setError(""); setStatus(""); setEditorKey(value => value + 1);
  }
  const appUrl = selected?.status === "active" ? (() => {
    const params = new URLSearchParams({ workspace });
    const library = new URLSearchParams(window.location.search).get("library");
    if (library) params.set("library", library);
    return `/apps/${encodeURIComponent(selected.name)}/?${params}`;
  })() : null;
  return <dialog ref={dialog} aria-label="Worker apps" onCancel={event => { event.preventDefault(); if (!busy && allowLeave()) onClose(); }} style={{ width: "min(1100px, 95vw)", maxHeight: "92vh", padding: 24, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)", overflow: "auto" }}>
    <header className="script-fields"><h1>Worker apps</h1><button type="button" disabled={busy} onClick={() => { if (allowLeave()) onClose(); }}>Close Worker apps</button></header>
    <p>Deploy ordinary Workers with native bindings. Updates and source restores keep resource data.</p>
    <div className="script-fields"><button disabled={busy} onClick={newApp}>New Worker app</button><button disabled={busy} onClick={() => void perform(loadList)}>Refresh apps</button></div>
    {apps.length ? <ul aria-label="Worker app list">{apps.map(app => <li key={app.name}><button disabled={busy} onClick={() => { if (allowLeave()) void perform(() => loadApp(app.name)); }}>{app.name}</button> <span>{app.status.replaceAll("-", " ")} · {app.provider}</span></li>)}</ul> : <p>No Worker apps saved.</p>}
    {!providers.length ? <p role="status">No Worker app provider is available on this deployment.</p> : null}
    {selected ? <p role="status">Deployment: {selected.status.replaceAll("-", " ")}{selected.active_revision ? ` · revision ${selected.active_revision.slice(0, 12)}` : ""}{appUrl ? <> · <a href={appUrl} target="_blank" rel="noopener">Open private app</a></> : null}</p> : null}
    {selected?.error ? <p role="alert">{selected.error}</p> : null}
    <form className="source-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = decode<App & { ok: boolean }>(await galleryTool(workspace, "app_write", { name, source, manifest: JSON.parse(manifest), project, provider, expected_revision: baseRevision }));
      setDirty(false); await loadList(); await loadApp(name); setStatus(result.ok ? "Worker app deployed" : "Worker app needs reconciliation");
    }, true); }}>
      <div className="script-fields"><label>Name<input aria-label="Worker app name" value={name} disabled={busy || !!selected} required onChange={event => { setName(event.target.value); setDirty(true); }} /></label><label>Provider<Select aria-label="Worker app provider" value={provider} disabled={busy || !!selected} onChange={event => { setProvider(event.target.value); setDirty(true); }}>{[...new Set([...providers, ...(selected ? [selected.provider] : [])])].map(value => <option key={value}>{value}</option>)}</Select></label></div>
      <label>Manifest<textarea aria-label="Worker app manifest" rows={12} value={manifest} disabled={busy} onChange={event => { setManifest(event.target.value); setDirty(true); }} style={{ width: "100%", background: "var(--page)", border: "1px solid var(--line)", padding: 12 }} /></label>
      <ProjectEditor key={editorKey} entries={[{ id: "worker", filename: "worker.ts", source }]} project={project} onEntryChange={(_, value) => { setSource(value); setDirty(true); }} onProjectChange={value => { setProject(value); setDirty(true); }} dependencyText={dependencies} onDependencyTextChange={value => { setDependencies(value); setDirty(true); }} onValidityChange={setValid} disabled={busy} />
      <div className="source-actions"><button className="primary-action" disabled={busy || !valid || !provider}>Save and deploy Worker</button>{dirty ? <span>Unsaved changes</span> : null}</div>
    </form>
    {selected ? <>
      <div className="script-fields"><button disabled={busy} onClick={() => void perform(async () => { await galleryTool(workspace, "app_reconcile", { name }); await loadList(); setSelected(decode<Snapshot>(await galleryTool(workspace, "app_read", { name }))); setStatus("Deployment reconciled"); })}>Reconcile deployment</button>
        <button disabled={busy || dirty} onClick={() => void perform(async () => {
          await galleryTool(workspace, "app_move", { name, library: library === "team" ? "private" : "team" });
          newApp(); await loadList(); setStatus(`App moved to ${library === "team" ? "personal" : "team"} library`);
        })}>Move to {library === "team" ? "personal" : "team"} library</button>
        <label>Revision<Select aria-label="Worker app revision" value={restoreId} onChange={event => setRestoreId(event.target.value)}>{revisions.map(revision => <option key={revision.id} value={revision.id}>{revision.id.slice(0, 12)} · {revision.created_at}</option>)}</Select></label>
        <button disabled={busy || !restoreId} onClick={() => { if (allowLeave()) void perform(async () => { await galleryTool(workspace, "app_restore", { name, revision_id: restoreId }); await loadList(); await loadApp(name); setStatus("Source restored and deployed; data retained"); }); }}>Restore Worker revision</button>
      </div>
      <SecretControls key={selected.name} workspace={workspace} name={selected.name} kind="app" onSaved={async () => { await loadList(); const saved = decode<Snapshot>(await galleryTool(workspace, "app_read", { name })); setSelected(saved); }} />
    </> : null}
    {error ? <p role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</p> : null}{status ? <p role="status">{status}</p> : null}
  </dialog>;
}
