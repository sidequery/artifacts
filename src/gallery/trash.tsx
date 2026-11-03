import { useCallback, useEffect, useState } from "react";
import { confirmLeavingDrafts, useDrafts } from "./drafts";
import { useGalleryTransport } from "./transport";
import type { GalleryArtifact } from "./types";

type TrashedItem = { workspace: string; kind: "artifact" | "script"; name: string; deleted_at: string };
type TrashPage = { items: TrashedItem[]; next_offset: number | null };
function value<T>(result: unknown): T { return (typeof result === "string" ? JSON.parse(result) : result) as T; }

export function DeletePanel({ artifact, onCancel, onDeleted }: {
  artifact: GalleryArtifact; onCancel: () => void; onDeleted: () => Promise<void>;
}) {
  const { tool } = useGalleryTransport();
  const { drafts } = useDrafts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="library-move" aria-label="Move to Trash" onSubmit={async event => {
    event.preventDefault();
    if (busy || !confirmLeavingDrafts(drafts)) return;
    setBusy(true); setError("");
    try {
      await tool(artifact.workspace, `${artifact.kind ?? "artifact"}_delete`, { name: artifact.name });
      await onDeleted();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }}>
    <p>Move <strong>{artifact.name}</strong> to Trash?</p>
    <p className="muted">Its link will stop working and schedules will pause. History, data, files and secrets are kept. You can restore it from Trash. Requests already running may finish.</p>
    <div className="script-fields"><button type="submit" disabled={busy}>{busy ? "Moving…" : "Move to Trash"}</button><button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
  </form>;
}

export function TrashPanel({ workspace, onRestored, onClose }: {
  workspace: string; onRestored: () => Promise<void>; onClose: () => void;
}) {
  const { tool } = useGalleryTransport();
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    let offset = 0;
    const items: TrashedItem[] = [];
    do {
      const page = value<TrashPage>(await tool(workspace, "artifacts_trash", { all: true, offset }));
      items.push(...page.items);
      if (page.next_offset === null) break;
      if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error("Invalid Trash pagination");
      offset = page.next_offset;
    } while (true);
    return items;
  }, [workspace, tool]);
  useEffect(() => {
    let cancelled = false;
    void load().then(items => { if (!cancelled) setItems(items); }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);
  return <section className="script-panel trash-panel" aria-label="Trash">
    <div className="source-actions"><h2>Trash</h2><button type="button" onClick={onClose}>Back to library</button></div>
    <p className="muted">Restore an item with its original link, history and stored data. Schedules stay paused until you resume them. Names and links are reserved while in Trash.</p>
    {loading ? <p role="status">Loading Trash…</p> : null}
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {!loading && !error && items.length === 0 ? <p>Trash is empty.</p> : null}
    {items.map(item => <div className="source-actions trash-item" key={JSON.stringify([item.workspace, item.kind, item.name])}>
      <span><strong>{item.name}</strong> · {item.kind} · {item.workspace}</span>
      <button type="button" disabled={busy} aria-label={`Restore ${item.name}`} onClick={async () => {
        setBusy(true); setError("");
        try {
          await tool(item.workspace, `${item.kind}_undelete`, { name: item.name });
          setItems(await load());
          await onRestored();
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
      }}>Restore</button>
    </div>)}
  </section>;
}
