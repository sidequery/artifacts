import {ExecutionControls} from "./execution-controls";
import { useEffect, useState } from "react";
import { ProjectEditor, emptyEditableProject } from "./project-editor";
import { loadSourceSnapshot, useProjectDraft, type SourceSnapshot } from "./drafts";
import type { GalleryArtifact } from "./types";
import { Select } from "./select";
export type ScriptView = "source" | "requests" | "activity" | "secrets";

type ToolResult = { error?: string; isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
export type MutationResult = { applied?: boolean; ok?: boolean; revision_token?: string; error?: string };
export class GalleryToolError extends Error {
  constructor(message: string, readonly status: number, readonly result?: MutationResult) { super(message); }
}
export async function galleryTool(workspace: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const params = new URLSearchParams({ workspace });
  const library = new URLSearchParams(window.location.search).get("library");
  if (library) params.set("library", library);
  const response = await fetch(`/api/tools?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
  const result = await response.json() as ToolResult;
  const text = result.content?.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
  if (!response.ok || result.isError) {
    let detail = result.structuredContent as MutationResult | undefined;
    if (!detail && text) { try { detail = JSON.parse(text); } catch {} }
    throw new GalleryToolError(result.error || text || `Request failed (${response.status})`, response.status, detail);
  }
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
function ConflictActions({ sourceUrl, dirty, onReload }: { sourceUrl: string; dirty: boolean; onReload: (snapshot: SourceSnapshot) => void }) {
  const [comparison, setComparison] = useState<SourceSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(reload: boolean) {
    if (reload && dirty && !window.confirm("Discard these unsaved edits and reload the saved project?")) return;
    setBusy(true); setError("");
    try {
      const snapshot = await loadSourceSnapshot(sourceUrl);
      if (reload) onReload(snapshot);
      else setComparison(snapshot);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <div className="save-conflict">
    <button type="button" disabled={busy} onClick={() => void load(false)}>Compare saved project</button>
    <button type="button" disabled={busy} onClick={() => void load(true)}>Reload saved project</button>
    {error ? <p role="alert">{error}</p> : null}
    {comparison ? <details open><summary>Saved project (your edits remain in the editor)</summary><pre>{show(comparison)}</pre></details> : null}
  </div>;
}
const initialSource = `export default {\n  async fetch(request, env, ctx) {\n    return Response.json({ message: "Hello" });\n  },\n} satisfies ExportedHandler<ScriptEnv>;\n`;
export function ScriptPanel({ artifact, workspace, version, sourceUrl, onSaved, onCancel, view = "source" }: { artifact?: GalleryArtifact; workspace: string; version?: string; sourceUrl?: string; onSaved: (name: string) => Promise<void>; onCancel?: () => void; view?: ScriptView }) {
  const buffer = useProjectDraft(artifact ? `${artifact.key}:${version}` : `new-script:${workspace}`);
  const { draft } = buffer;
  const name = artifact?.name ?? draft?.content.name ?? "";
  const slug = draft?.content.slug ?? "";
  const access = draft?.content.access ?? "private";
  const contents = draft?.content.source ?? "";
  const project = draft?.content.project ?? emptyEditableProject();
  const [projectValid, setProjectValid] = useState(true);
  const [projectLoad, setProjectLoad] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
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
    if (draft) return;
    if (!artifact) { buffer.reset({ source: initialSource, project: emptyEditableProject(), name: "", slug: "", access: "private" }); return; }
    if (!sourceUrl) return;
    const controller = new AbortController(); setError("");
    void loadSourceSnapshot(sourceUrl, controller.signal).then(snapshot => { if (!controller.signal.aborted) buffer.reset(snapshot); }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [sourceUrl, buffer.reset]);
  const sourceReady = !!draft;
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setStatus("");
    try { await action(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <div className="script-panel">
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {conflict && sourceUrl ? <ConflictActions sourceUrl={sourceUrl} dirty={draft?.dirty ?? false} onReload={snapshot => { buffer.reset(snapshot); setConflict(false); setError(""); setProjectLoad(value => value + 1); }} /> : null}
    <form className="source-form" hidden={view !== "source"} onSubmit={event => {
      event.preventDefault();
      if (busy || !sourceReady || !projectValid || !name.trim()) return;
      void perform(async () => {
        try {
          const result = await galleryTool(workspace, historical ? "script_restore" : "script_write", historical ? { name, version_id: version } : { name, contents, project, expected_revision: artifact ? draft!.content.revision_token : null, ...(!artifact ? { ...(slug ? { slug } : {}), access } : {}) }) as MutationResult;
          buffer.saved(result.revision_token);
          if (historical) buffer.invalidateClean(`${artifact!.key}:working`);
          setConflict(false);
          if (!artifact) buffer.clear();
        } catch (error) {
          if (error instanceof GalleryToolError) {
            setConflict(error.status === 409);
            if (error.result?.applied) { buffer.saved(error.result.revision_token); if (artifact) await onSaved(name); }
          }
          throw error;
        }
        await onSaved(name); setStatus(historical ? "Revision restored" : "Script saved");
      });
    }}>
      {!artifact ? <div className="script-fields">
        <label>Name<input aria-label="Script name" required value={name} onChange={event => buffer.update({name: event.target.value})} /></label>
        <label>URL slug<input aria-label="Script slug" value={slug} onChange={event => buffer.update({slug: event.target.value})} /></label>
        <label>Link access<Select aria-label="Script access" value={access} onChange={event => buffer.update({access: event.target.value as typeof access})}><option value="private">Private</option><option value="public">Public</option></Select></label>
        <p className="link-note">An HTTP handler. Visiting its URL runs the script and returns its response.</p>
      </div> : null}
      {draft ? <ProjectEditor key={projectLoad} entries={[{ id: "script", filename: "script.ts", source: contents }]} project={project} onProjectChange={project => buffer.update({project})} onEntryChange={(_, source) => buffer.update({source})} dependencyText={draft.dependencyText} onDependencyTextChange={text => buffer.update({}, text)} readOnly={historical} disabled={busy} onValidityChange={setProjectValid} /> : <p role="status">Loading source…</p>}
      <div className="source-actions">
        {historical ? <span className="source-readonly muted">Read-only revision</span> : null}
        {draft?.dirty ? <span role="status">Unsaved changes</span> : null}
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
  const buffer = useProjectDraft(`${artifact.key}:${version}`);
  const snapshot = buffer.draft?.content;
  const [projectLoad, setProjectLoad] = useState(0);
  const [projectValid, setProjectValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState("");
  const historical = version !== "working";
  useEffect(() => {
    if (snapshot) return;
    const controller = new AbortController(); setError(""); setStatus(""); setProjectValid(true);
    void loadSourceSnapshot(sourceUrl, controller.signal).then(value => { if (!controller.signal.aborted) buffer.reset(value); }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [sourceUrl, buffer.reset]);
  const loaded = !!snapshot;
  async function save() {
    if (!loaded || !snapshot) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const result = await galleryTool(artifact.workspace, historical ? "artifact_restore" : "artifact_write", historical ? { version_id: version } : { name: artifact.name, contents: snapshot.source, server: snapshot.server_source ?? null, project: snapshot.project, expected_revision: snapshot.revision_token }) as MutationResult;
      buffer.saved(result.revision_token); setConflict(false);
      if (historical) buffer.invalidateClean(`${artifact.key}:working`);
      await onSaved(); setStatus(historical ? "Revision restored" : "Artifact saved");
    } catch (error) {
      if (error instanceof GalleryToolError) {
        setConflict(error.status === 409);
        if (error.result?.applied) { buffer.saved(error.result.revision_token); await onSaved(); }
      }
      setError(message(error));
    } finally { setBusy(false); }
  }
  return <form className="script-panel source-form" onSubmit={event => { event.preventDefault(); if (!busy && loaded && projectValid) void save(); }}>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {conflict ? <ConflictActions sourceUrl={sourceUrl} dirty={buffer.draft?.dirty ?? false} onReload={snapshot => { buffer.reset(snapshot); setConflict(false); setError(""); setProjectLoad(value => value + 1); }} /> : null}
    {!snapshot ? <p role="status">Loading source…</p> : <ProjectEditor key={projectLoad} entries={[{ id: "client", filename: `${artifact.name}.artifact.tsx`, source: snapshot.source }, ...(snapshot.server_source === null || snapshot.server_source === undefined ? [] : [{ id: "server", filename: `${artifact.name}.artifact.server.ts`, source: snapshot.server_source }])]} project={snapshot.project} onProjectChange={project => buffer.update({project})} onEntryChange={(id, source) => buffer.update(id === "server" ? { server_source: source } : { source })} dependencyText={buffer.draft!.dependencyText} onDependencyTextChange={text => buffer.update({}, text)} readOnly={historical} disabled={busy} onValidityChange={setProjectValid} />}
    <div className="source-actions">{historical ? <span className="source-readonly muted">Read-only revision</span> : null}{buffer.draft?.dirty ? <span role="status">Unsaved changes</span> : null}<button type="submit" disabled={busy || !loaded || !projectValid}>{historical ? "Restore revision" : "Save artifact"}</button>{status ? <p role="status">{status}</p> : null}</div>
  </form>;
}
