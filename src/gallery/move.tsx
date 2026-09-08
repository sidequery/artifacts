import { useState } from "react";
import type { GalleryArtifact } from "./types";

export function MovePanel({ artifact, library, onCancel }: {
  artifact: GalleryArtifact; library: "private" | "team"; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const destination = library === "private" ? "team" : "private";
  const target = destination === "team" ? "team library" : "my personal library";
  return <form className="library-move" aria-label="Move between libraries" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({library, workspace: artifact.workspace});
      const response = await fetch(`/api/library/move?${params}`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({kind: artifact.kind ?? "artifact", name: artifact.name, library: destination}),
      });
      const result = await response.json() as {ok?:boolean;error?:string};
      if (!response.ok || !result.ok) throw new Error(result.error ?? `Move failed (${response.status})`);
      const url = new URL(window.location.href);
      url.searchParams.set("library", destination);
      url.searchParams.set("workspace", artifact.workspace);
      url.searchParams.set("name", artifact.name);
      url.searchParams.set("kind", artifact.kind ?? "artifact");
      window.location.assign(url.href);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  }}>
    <p>Move <strong>{artifact.name}</strong> to {target}?</p>
    <p className="muted">{destination === "team" ? "Everyone with team library access will be able to view and edit it, including its data and secrets." : "It will leave the team library. Only you will have personal library access."} Its history, data, secrets, schedules, and URL stay with it. Public links remain public.</p>
    <div className="script-fields"><button type="submit" disabled={busy}>{busy ? "Moving…" : `Move to ${target}`}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
  </form>;
}
