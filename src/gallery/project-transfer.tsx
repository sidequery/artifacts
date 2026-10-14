import { useState } from "react";
import { GalleryToolError, galleryTool, type MutationResult } from "./hosted";
import { MAX_PROJECT_ARCHIVE_BYTES, PROJECT_ARCHIVE_FORMAT, type ProjectArchive } from "../project-archive-contract";

const count = (amount: number, singular: string, plural: string) => `${amount} ${amount === 1 ? singular : plural}`;

export function ProjectImportPanel({ workspace, hosted, onSaved, onImported, onCancel }: { workspace: string; hosted: boolean; onSaved: (name: string, kind: ProjectArchive["kind"]) => Promise<void>; onImported: (message: string) => void; onCancel: () => void }) {
  const [archive, setArchive] = useState<ProjectArchive | null>(null);
  const [name, setName] = useState(""), [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<MutationResult | null>(null);
  return <form className="project-import" onSubmit={event => {
    event.preventDefault(); if (!archive || busy || !name.trim()) return;
    setBusy(true); setError(""); setDiagnostics(null);
    void (async () => {
      try {
        await galleryTool(workspace, `${archive.kind}_import`, { new_name: name.trim(), archive, ...(hosted && slug ? { slug } : {}) });
        await onSaved(name.trim(), archive.kind); onImported(hosted ? "Project imported with private access." : "Project imported.");
      } catch (error) {
        if (error instanceof GalleryToolError && error.result?.applied) {
          await onSaved(name.trim(), archive.kind); setDiagnostics(error.result); setError("Project imported as an invalid draft. Fix the source diagnostics before deployment.");
        } else setError(error instanceof Error ? error.message : String(error));
      } finally { setBusy(false); }
    })();
  }}>
    <p>Creates a fresh project from saved source, helpers and exact dependency bytes. Databases, files, UI state, secrets and schedules stay with the original project. Hosted imports start private.</p>
    {!hosted ? <p>Filesystem previews preserve server source but do not execute it. Import script archives with the artifacts CLI.</p> : null}
    <label>Project archive<input aria-label="Project archive" type="file" accept="application/json,.json" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]; setArchive(null); setError(""); setDiagnostics(null);
      if (!file) return;
      if (file.size > MAX_PROJECT_ARCHIVE_BYTES) { setError("Project archive exceeds 10 MiB."); return; }
      setBusy(true);
      void file.text().then(text => {
        const value = JSON.parse(text) as ProjectArchive;
        if (!value || value.format !== PROJECT_ARCHIVE_FORMAT || value.version !== 1 || !["artifact", "script"].includes(value.kind) || typeof value.name !== "string" || typeof value.source !== "string" || !value.project || !value.project.files || !value.project.dependencies || !value.project.lock) throw new Error("Choose a complete version 1 project archive exported by Artifacts.");
        if (!hosted && value.kind === "script") throw new Error("Import script archives with artifacts import NEW_NAME --file ARCHIVE_JSON.");
        setArchive(value); setName(`${value.name}-import`); setSlug("");
      }).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
    }} /></label>
    {archive ? <p className="import-summary">{archive.kind === "script" ? "Script" : "Interactive artifact"} · {count(Object.keys(archive.project.files).length, "helper file", "helper files")} · {count(Object.keys(archive.project.dependencies).length, "dependency", "dependencies")}{archive.server_source ? " · Includes backend source" : ""}</p> : null}
    <label>New name<input aria-label="Imported project name" value={name} required disabled={busy || !archive} onChange={event => setName(event.target.value)} /></label>
    {hosted ? <label>URL slug<input aria-label="Imported project slug" value={slug} placeholder="Defaults to the new name" disabled={busy || !archive} onChange={event => setSlug(event.target.value)} /></label> : null}
    <div className="import-actions">
      <button className="primary-action" disabled={busy || !archive || !name.trim()}>Import as new project</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {diagnostics ? <details open><summary>Import diagnostics</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details> : null}
  </form>;
}
