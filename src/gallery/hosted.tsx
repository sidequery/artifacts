import {ExecutionControls} from "./execution-controls";
import { useEffect, useState } from "react";
import { ProjectEditor, editableProject, emptyEditableProject, type EditableProject } from "./project-editor";
import type { GalleryArtifact } from "./types";
import { Select } from "./select";
export type ScriptView = "source" | "requests" | "activity" | "secrets";

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
    try { await galleryTool(artifact.workspace, "artifact_link", { kind: artifact.kind ?? "artifact", name: artifact.name, slug, access }); await onSaved(); setStatus("Link saved"); }
    catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  }}>
    <label>URL slug<input aria-label="URL slug" required value={slug} onChange={event => setSlug(event.target.value)} /></label>
    <label>Link access<Select aria-label="URL access" value={access} onChange={event => setAccess(event.target.value as typeof access)}><option value="private">Private</option><option value="public">Public</option></Select></label>
    <button disabled={busy}>Save link</button>
    {artifact.url ? <><a className="download-link" href={artifact.url} target="_blank" rel="noopener noreferrer">Open</a><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(new URL(artifact.url!, window.location.origin).href); setStatus("URL copied"); } catch (error) { setStatus(message(error)); } }}>Copy URL</button></> : null}
    <span role="status">{status}</span>
    <p className="link-note">Private links use the library’s access. Public links allow anyone through the app’s access check; deployment authentication may still apply. This setting does not move the item between libraries.</p>
  </form>;
}
type SourceSnapshot = { source: string; server_source?: string | null; project: EditableProject };
async function loadSourceSnapshot(sourceUrl: string, signal: AbortSignal): Promise<SourceSnapshot> {
  const url = new URL(sourceUrl, window.location.href); url.searchParams.set("format", "json");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Source request failed (${response.status})`);
  const value = await response.json() as SourceSnapshot;
  if (typeof value.source !== "string" || (value.server_source !== undefined && value.server_source !== null && typeof value.server_source !== "string")) throw new Error("Invalid source snapshot.");
  return { ...value, project: editableProject(value.project) };
}
const initialSource = `export default {\n  async fetch(request, env, ctx) {\n    return Response.json({ message: "Hello" });\n  },\n} satisfies ExportedHandler<ScriptEnv>;\n`;
export function ScriptPanel({ artifact, workspace, version, sourceUrl, onSaved, onCancel, view = "source" }: { artifact?: GalleryArtifact; workspace: string; version?: string; sourceUrl?: string; onSaved: (name: string) => Promise<void>; onCancel?: () => void; view?: ScriptView }) {
  const [name, setName] = useState(artifact?.name ?? "");
  const [slug, setSlug] = useState(artifact?.slug ?? "");
  const [access, setAccess] = useState(artifact?.access ?? "private");
  const [contents, setContents] = useState(artifact ? "" : initialSource);
  const [loaded, setLoaded] = useState(!artifact);
  const [loadedUrl, setLoadedUrl] = useState<string | undefined>(undefined);
  const [project, setProject] = useState(emptyEditableProject);
  const [projectValid, setProjectValid] = useState(true);
  const [projectLoad, setProjectLoad] = useState(0);
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
    void loadSourceSnapshot(sourceUrl, controller.signal).then(snapshot => { if (!controller.signal.aborted) { setContents(snapshot.source); setProject(snapshot.project); setProjectValid(true); setProjectLoad(value => value + 1); setLoadedUrl(sourceUrl); setLoaded(true); } }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [sourceUrl]);
  const sourceReady = loaded && (!artifact || (!!sourceUrl && loadedUrl === sourceUrl));
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setStatus("");
    try { await action(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <div className="script-panel">
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    <form className="source-form" hidden={view !== "source"} onSubmit={event => {
      event.preventDefault();
      if (busy || !sourceReady || !projectValid || !name.trim()) return;
      void perform(async () => {
        if (historical) await galleryTool(workspace, "script_restore", { name, version_id: version });
        else await galleryTool(workspace, "script_write", { name, contents, project, ...(!artifact ? { ...(slug ? { slug } : {}), access } : {}) });
        await onSaved(name); setStatus(historical ? "Revision restored" : "Script saved");
      });
    }}>
      {!artifact ? <div className="script-fields">
        <label>Name<input aria-label="Script name" required value={name} onChange={event => setName(event.target.value)} /></label>
        <label>URL slug<input aria-label="Script slug" value={slug} onChange={event => setSlug(event.target.value)} /></label>
        <label>Link access<Select aria-label="Script access" value={access} onChange={event => setAccess(event.target.value as typeof access)}><option value="private">Private</option><option value="public">Public</option></Select></label>
        <p className="link-note">An HTTP handler. Visiting its URL runs the script and returns its response.</p>
      </div> : null}
      <ProjectEditor key={projectLoad} entries={[{ id: "script", filename: "script.ts", source: contents }]} project={project} onProjectChange={setProject} onEntryChange={(_, source) => setContents(source)} readOnly={historical} disabled={!sourceReady || busy} onValidityChange={setProjectValid} />
      <div className="source-actions">
        {historical ? <span className="source-readonly muted">Read-only revision</span> : null}
        <button type="submit" disabled={busy || !sourceReady || !projectValid || !name.trim()}>{historical ? "Restore revision" : "Save script"}</button>
        {onCancel ? <button type="button" onClick={onCancel} disabled={busy}>Cancel</button> : null}
        {status ? <p role="status">{status}</p> : null}
      </div>
    </form>
    {artifact ? <>
      <section className="script-activity" aria-label="Script requests" hidden={view !== "requests"}>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => {
          const parsed: unknown = JSON.parse(headers);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("Headers must be a JSON object of string values.");
          if (!path.startsWith("/")) throw new Error("Path must start with /.");
          const result = await galleryTool(workspace, "script_run", { name, request: { path, method, headers: Object.entries(parsed), ...(method !== "GET" && method !== "HEAD" && body ? { body: encodeRequestBody(body) } : {}) } });
          setOutput(formatScriptResponse(result));
        }); }}>
          <p className="muted">Runs the current saved script. Unsaved source changes are not included.</p>
          <div className="script-fields">
            <label>Method<Select aria-label="Request method" value={method} onChange={event => setMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => <option key={value}>{value}</option>)}</Select></label>
            <label>Path<input aria-label="Request path" value={path} onChange={event => setPath(event.target.value)} /></label>
            <button disabled={busy}>Run script</button>
          </div>
          <label>Headers (JSON)<textarea aria-label="Request headers" value={headers} onChange={event => setHeaders(event.target.value)} /></label>
          {method !== "GET" && method !== "HEAD" ? <label>Body<textarea aria-label="Request body" value={body} onChange={event => setBody(event.target.value)} /></label> : null}
        </form>
        {output ? <pre aria-label="Script response">{output}</pre> : null}
      </section>
      <section className="script-activity artifact-execution" aria-label="Script activity" hidden={view !== "activity"}>
        <ExecutionControls key={`${workspace}/${name}`} workspace={workspace} name={name}/>
        <details><summary>Logs</summary><button disabled={busy} onClick={() => void perform(async () => setLogs(show(await galleryTool(workspace, "script_logs", { name }))))}>Load logs</button><pre aria-label="Script logs">{logs}</pre></details>
      </section>
      <section className="script-activity" aria-label="Script secrets" hidden={view !== "secrets"}>
        <p>Secrets are available to this script on the server. Their values are never shown in the source editor.</p>
        <form onSubmit={event => { event.preventDefault(); void perform(async () => { await galleryTool(workspace, "script_secrets", { name, secrets: { [secretName]: secretValue } }); setSecretValue(""); setStatus("Secret saved"); }); }}>
          <div className="script-fields">
            <label>Name<input aria-label="Secret name" required value={secretName} onChange={event => setSecretName(event.target.value)} /></label>
            <label>Value<input aria-label="Secret value" type="password" autoComplete="new-password" value={secretValue} onChange={event => setSecretValue(event.target.value)} /></label>
            <button disabled={busy}>Save secret</button>
            <button type="button" disabled={busy || !secretName} onClick={() => void perform(async () => { await galleryTool(workspace, "script_secrets", { name, secrets: { [secretName]: null } }); setSecretValue(""); setStatus("Secret removed"); })}>Remove secret</button>
          </div>
        </form>
        {status ? <p role="status">{status}</p> : null}
      </section>
    </> : null}
  </div>;
}

export function ArtifactSourcePanel({ artifact, version, sourceUrl, onSaved }: { artifact: GalleryArtifact; version: string; sourceUrl: string; onSaved: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null);
  const [loadedUrl, setLoadedUrl] = useState("");
  const [projectValid, setProjectValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const historical = version !== "working";
  useEffect(() => {
    const controller = new AbortController(); setLoadedUrl(""); setSnapshot(null); setError(""); setStatus(""); setProjectValid(true);
    void loadSourceSnapshot(sourceUrl, controller.signal).then(value => { if (!controller.signal.aborted) { setSnapshot(value); setLoadedUrl(sourceUrl); } }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [sourceUrl]);
  const loaded = snapshot !== null && loadedUrl === sourceUrl;
  async function save() {
    if (!loaded || !snapshot) return;
    setBusy(true); setError(""); setStatus("");
    try {
      await galleryTool(artifact.workspace, historical ? "artifact_restore" : "artifact_write", historical ? { version_id: version } : { name: artifact.name, contents: snapshot.source, server: snapshot.server_source ?? null, project: snapshot.project });
      await onSaved(); setStatus(historical ? "Revision restored" : "Artifact saved");
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <form className="script-panel source-form" onSubmit={event => { event.preventDefault(); if (!busy && loaded && projectValid) void save(); }}>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {!loaded ? <p role="status">Loading source…</p> : <ProjectEditor key={loadedUrl} entries={[{ id: "client", filename: `${artifact.name}.artifact.tsx`, source: snapshot.source }, ...(snapshot.server_source === null || snapshot.server_source === undefined ? [] : [{ id: "server", filename: `${artifact.name}.artifact.server.ts`, source: snapshot.server_source }])]} project={snapshot.project} onProjectChange={project => setSnapshot({ ...snapshot, project })} onEntryChange={(id, source) => setSnapshot(id === "server" ? { ...snapshot, server_source: source } : { ...snapshot, source })} readOnly={historical} disabled={busy} onValidityChange={setProjectValid} />}
    <div className="source-actions">{historical ? <span className="source-readonly muted">Read-only revision</span> : null}<button type="submit" disabled={busy || !loaded || !projectValid}>{historical ? "Restore revision" : "Save artifact"}</button>{status ? <p role="status">{status}</p> : null}</div>
  </form>;
}
