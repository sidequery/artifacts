import { useState } from "react";
import type { GalleryArtifact } from "./types";
import { galleryTool } from "./hosted";

export function RemixPanel({ artifact, version, onSaved, onCancel }: {
  artifact: GalleryArtifact; version: string; onSaved: (name: string) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(`${artifact.name}-remix`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="link-settings" aria-label="Remix artifact" onSubmit={async event => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await galleryTool(artifact.workspace, `${artifact.kind ?? "artifact"}_remix`, {
        ...(version === "working" ? { name: artifact.name } : { version_id: version }), new_name: name,
      });
      await onSaved(name);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }}>
    <label>Remix name <input autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
    <span className="muted">Fresh data and secrets. Hosted URLs start private.</span>
    <button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating remix…" : "Create remix"}</button>
    <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    {error ? <span role="alert" className="error-message">{error}</span> : null}
  </form>;
}
