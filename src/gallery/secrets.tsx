import { useGalleryTransport } from "./transport";
import { useEffect, useRef, useState } from "react";
import { GalleryToolError } from "./hosted";

// `required` lists declared secret names. Only those reach the runtime, so rows show which still need a value and which saved values go unused.
export function SecretControls({ workspace, name, kind, required, onSaved, active = true }: { workspace: string; name: string; kind: "script" | "artifact" | "app"; required?: string[]; onSaved?: () => Promise<void>; active?: boolean }) {
  const { tool: galleryTool } = useGalleryTransport();
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const valueInput = useRef<HTMLInputElement>(null);
  const rows = loaded ? [...new Set([...(required ?? []), ...names])] : [];
  async function update(secrets?: Record<string, string | null>) {
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await galleryTool(workspace, `${kind}_secrets`, { name, ...(secrets ? { secrets } : {}) });
      const payload = (typeof result === "string" ? JSON.parse(result) : result) as { names: string[]; deployment?: { ok?: boolean; error?: string } };
      setNames(payload.names);
      setLoaded(true);
      if (secrets) setSecretValue("");
      if (secrets && onSaved) await onSaved();
      setStatus(!secrets ? "" : secrets[secretName] === null ? "Secret removed" : "Secret saved");
    } catch (error) {
      const result = error instanceof GalleryToolError ? error.result as { names?: string[] } | undefined : undefined;
      if (secrets && result?.names) {
        setNames(result.names); setSecretValue("");
        if (onSaved) await onSaved();
      }
      setError(error instanceof Error ? error.message : String(error));
    }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active && !loaded) void update(); }, [active, workspace, name, kind]);
  return <section className="secret-controls" aria-label={kind === "script" ? "Script secrets" : kind === "app" ? "App secrets" : "Artifact secrets"}>
    <p className="settings-description">Available to this {kind === "script" ? "script" : kind === "app" ? "native Worker" : "artifact server"} on the server. Saved values stay hidden.{kind === "app" ? " Saving a secret redeploys the current revision." : ""}</p>
    <div className="secret-list-header"><h3>{required ? "Secret values" : "Saved secrets"}</h3><button type="button" aria-label="Load secret names" disabled={busy} onClick={() => void update()}>Refresh</button></div>
    <ul className="secret-list" aria-label="Secret names" aria-busy={busy}>
      {rows.map(name => {
        const saved = names.includes(name);
        return <li key={name}>
          <span className="secret-name"><code>{name}</code>
            {!saved ? <span className="secret-state"><span className="status-dot" data-tone="warning" aria-hidden="true" />Needs a value</span> : null}
            {saved && required && !required.includes(name) ? <span className="secret-state">Not passed to the Worker</span> : null}
          </span>
          <button type="button" disabled={busy} onClick={() => { setSecretName(name); setSecretValue(""); setConfirmingRemove(false); valueInput.current?.focus(); }}>{saved ? "Replace" : "Set value"}</button>
        </li>;
      })}
      {!rows.length ? <li className="muted">{loaded ? "No secrets saved yet." : "Loading secrets…"}</li> : null}
    </ul>
    <form onSubmit={event => { event.preventDefault(); void update({ [secretName]: secretValue }); }}>
      <fieldset disabled={busy}>
        <legend>{names.includes(secretName) ? "Replace secret" : "Add a secret"}</legend>
        <div className="settings-fields">
          <label>Name<input aria-label="Secret name" placeholder="API_KEY" required autoComplete="off" spellCheck={false} value={secretName} onChange={event => { setSecretName(event.target.value); setConfirmingRemove(false); }} /></label>
          <label>Value<input ref={valueInput} aria-label="Secret value" placeholder="Enter a secret value" type="password" autoComplete="new-password" value={secretValue} onChange={event => setSecretValue(event.target.value)} /></label>
        </div>
        <div className="settings-actions">
          <button className="primary-action" disabled={busy}>Save secret</button>
          {confirmingRemove ? <>
            <span className="confirm-prompt">Remove {secretName}?</span>
            <button className="destructive-action confirm" type="button" disabled={busy} onClick={() => { setConfirmingRemove(false); void update({ [secretName]: null }); }}>Remove</button>
            <button type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>Cancel</button>
          </> : names.includes(secretName) ? <button className="destructive-action" type="button" disabled={busy} onClick={() => setConfirmingRemove(true)}>Remove secret</button> : null}
        </div>
      </fieldset>
    </form>
    <p className="settings-feedback" role="status">{status}</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
