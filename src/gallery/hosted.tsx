import { useEffect, useState } from "react";
import type { GalleryArtifact } from "./types";

type ToolResult = { error?: string; isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
export async function galleryTool(workspace: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const params = new URLSearchParams({ workspace });
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  const response = await fetch(`/api/tools?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
  const result = await response.json() as ToolResult;
  const text = result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
  if (!response.ok || result.isError) throw new Error(result.error || text || `Request failed (${response.status})`);
  return result.structuredContent ?? text ?? result;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function formatScriptResponse(value: unknown): string {
  if (!value || typeof value !== "object" || !("response" in value)) return show(value);
  const response = (value as { response: { status: number; statusText?: string; headers: [string, string][]; body?: string } }).response;
  const heading = [`${response.status} ${response.statusText ?? ""}`.trim(), ...response.headers.map(([name, value]) => `${name}: ${value}`)].join("\n");
  if (!response.body) return heading;
  const bytes = Uint8Array.from(atob(response.body), character => character.charCodeAt(0));
  try { return heading + "\n\n" + new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return heading + `\n\n[Binary body: ${bytes.length} bytes]\nBase64: ${response.body}`; }
}
export function encodeRequestBody(body: string): string {
  return btoa(Array.from(new TextEncoder().encode(body), byte => String.fromCharCode(byte)).join(""));
}
export function LinkSettings({ artifact, onSaved }: { artifact: GalleryArtifact; onSaved: () => Promise<void> }) {
  const [slug, setSlug] = useState(artifact.slug ?? "");
  const [access, setAccess] = useState(artifact.access ?? "private");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => { setSlug(artifact.slug ?? ""); setAccess(artifact.access ?? "private"); }, [artifact.slug, artifact.access]);
  return <form className="link-settings" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setStatus("");
    try { await galleryTool(artifact.workspace, "artifact_link", { kind: artifact.kind ?? "canvas", name: artifact.name, slug, access }); await onSaved(); setStatus("Link saved"); }
    catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  }}>
    <label>URL / <input aria-label="URL slug" required value={slug} onChange={event => setSlug(event.target.value)} /></label>
    <select aria-label="URL access" value={access} onChange={event => setAccess(event.target.value as typeof access)}><option value="private">Private</option><option value="public">Public</option></select>
    <button disabled={busy}>Save link</button>
    {artifact.url ? <><a className="download-link" href={artifact.url} target="_blank" rel="noopener noreferrer">Open</a><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(new URL(artifact.url!, window.location.origin).href); setStatus("URL copied"); } catch (error) { setStatus(message(error)); } }}>Copy URL</button></> : null}
    <span role="status">{status}</span>
  </form>;
}
const initialSource = `export default {\n  async fetch(request, env, ctx) {\n    return Response.json({ message: "Hello" });\n  },\n} satisfies ExportedHandler<ScriptEnv>;\n`;
export function ScriptPanel({ artifact, workspace, version, sourceUrl, onSaved, onCancel }: { artifact?: GalleryArtifact; workspace: string; version?: string; sourceUrl?: string; onSaved: (name: string) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState(artifact?.name ?? "");
  const [slug, setSlug] = useState(artifact?.slug ?? "");
  const [access, setAccess] = useState(artifact?.access ?? "private");
  const [contents, setContents] = useState(artifact ? "" : initialSource);
  const [loaded, setLoaded] = useState(!artifact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [output, setOutput] = useState("");
  const [logs, setLogs] = useState("");
  const [path, setPath] = useState("/");
  const [method, setMethod] = useState("GET");
  const [headers, setHeaders] = useState("{}");
  const [body, setBody] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const historical = !!artifact && version !== "working";
  useEffect(() => {
    if (!sourceUrl) return;
    const controller = new AbortController(); setLoaded(false); setError("");
    void fetch(sourceUrl, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(`Source request failed (${response.status})`); return response.text(); }).then(text => { if (!controller.signal.aborted) { setContents(text); setLoaded(true); } }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [sourceUrl]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setStatus("");
    try { await action(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <div className="script-panel">
    {!artifact ? <div className="script-fields"><label>Name <input aria-label="Script name" value={name} onChange={event => setName(event.target.value)} /></label><label>URL / <input aria-label="Script slug" value={slug} onChange={event => setSlug(event.target.value)} /></label><select aria-label="Script access" value={access} onChange={event => setAccess(event.target.value as typeof access)}><option value="private">Private</option><option value="public">Public</option></select></div> : null}
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {status ? <p role="status">{status}</p> : null}
    <label className="source-editor-label">{historical ? "Revision source" : "Script source"}<textarea className="source-editor" aria-label="Script source" spellCheck={false} readOnly={historical || !loaded} value={contents} onChange={event => setContents(event.target.value)} /></label>
    <div className="script-fields">
      {historical ? <button disabled={busy || !loaded} onClick={() => void perform(async () => { await galleryTool(workspace, "script_restore", { name, version_id: version }); await onSaved(name); setStatus("Revision restored"); })}>Restore revision</button> : <button disabled={busy || !loaded || !name.trim()} onClick={() => void perform(async () => { await galleryTool(workspace, "script_write", { name, contents, ...(!artifact ? { ...(slug ? { slug } : {}), access } : {}) }); await onSaved(name); setStatus("Script saved"); })}>Save script</button>}
      {onCancel ? <button onClick={onCancel} disabled={busy}>Cancel</button> : null}
    </div>
    {artifact ? <>
      <details open><summary>Run</summary><form onSubmit={event => { event.preventDefault(); void perform(async () => {
        const parsed: unknown = JSON.parse(headers);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("Headers must be a JSON object of string values.");
        if (!path.startsWith("/")) throw new Error("Path must start with /.");
        const result = await galleryTool(workspace, "script_run", { name, request: { path, method, headers: Object.entries(parsed), ...(method !== "GET" && method !== "HEAD" && body ? { body: encodeRequestBody(body) } : {}) } });
        setOutput(formatScriptResponse(result));
      }); }}>
        <p className="muted">Runs the current saved script.</p>
        <div className="script-fields"><select aria-label="Request method" value={method} onChange={event => setMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => <option key={value}>{value}</option>)}</select><input aria-label="Request path" value={path} onChange={event => setPath(event.target.value)} /><button disabled={busy}>Run script</button></div>
        <label>Headers (JSON)<textarea aria-label="Request headers" value={headers} onChange={event => setHeaders(event.target.value)} /></label>
        {method !== "GET" && method !== "HEAD" ? <label>Body<textarea aria-label="Request body" value={body} onChange={event => setBody(event.target.value)} /></label> : null}
      </form>{output ? <pre aria-label="Script response">{output}</pre> : null}</details>
      <details><summary>Logs</summary><button disabled={busy} onClick={() => void perform(async () => setLogs(show(await galleryTool(workspace, "script_logs", { name }))))}>Load logs</button><pre aria-label="Script logs">{logs}</pre></details>
      <details><summary>Secrets</summary><form onSubmit={event => { event.preventDefault(); void perform(async () => { await galleryTool(workspace, "script_secrets", { name, secrets: { [secretName]: secretValue } }); setSecretValue(""); setStatus("Secret saved"); }); }}><div className="script-fields"><input aria-label="Secret name" placeholder="Name" required value={secretName} onChange={event => setSecretName(event.target.value)} /><input aria-label="Secret value" placeholder="Value" type="password" autoComplete="new-password" value={secretValue} onChange={event => setSecretValue(event.target.value)} /><button disabled={busy}>Save secret</button><button type="button" disabled={busy || !secretName} onClick={() => void perform(async () => { await galleryTool(workspace, "script_secrets", { name, secrets: { [secretName]: null } }); setSecretValue(""); setStatus("Secret removed"); })}>Remove secret</button></div></form></details>
    </> : null}
  </div>;
}
