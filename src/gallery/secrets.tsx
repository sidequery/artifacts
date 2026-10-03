import { useState } from "react";
import { galleryTool } from "./hosted";

export function SecretControls({ workspace, name, kind }: { workspace: string; name: string; kind: "script" | "artifact" }) {
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function update(secrets?: Record<string, string | null>) {
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await galleryTool(workspace, `${kind}_secrets`, { name, ...(secrets ? { secrets } : {}) });
      const payload = (typeof result === "string" ? JSON.parse(result) : result) as { names: string[] };
      setNames(payload.names);
      if (secrets) setSecretValue("");
      setStatus(secrets ? secrets[secretName] === null ? "Secret removed" : "Secret saved" : "Secret names loaded");
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="script-activity" aria-label={kind === "script" ? "Script secrets" : "Artifact secrets"}>
    <p>Secrets are available to this {kind === "script" ? "script" : "artifact backend"} on the server. Values are never shown in the source editor.</p>
    <button type="button" disabled={busy} onClick={() => void update()}>Load secret names</button>
    {names.length ? <ul aria-label="Secret names">{names.map(name => <li key={name}>{name}</li>)}</ul> : null}
    <form onSubmit={event => { event.preventDefault(); void update({ [secretName]: secretValue }); }}>
      <fieldset className="script-fields" style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
        <label>Name<input aria-label="Secret name" required value={secretName} onChange={event => setSecretName(event.target.value)} /></label>
        <label>Value<input aria-label="Secret value" type="password" autoComplete="new-password" value={secretValue} onChange={event => setSecretValue(event.target.value)} /></label>
        <button disabled={busy}>Save secret</button>
        <button type="button" disabled={busy || !secretName} onClick={() => void update({ [secretName]: null })}>Remove secret</button>
      </fieldset>
    </form>
    {status ? <p role="status">{status}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
