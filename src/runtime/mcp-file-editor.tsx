import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { OpenAIExtensions, OpenAIFileEntrypointInput, OpenAIResources } from "@openai/mcp-extensions/app";
import { SourceEditor } from "../gallery/source-editor";
import { galleryStyles } from "../gallery/styles";

export type ArtifactFileState = {
  draft: string; baseline: string; loaded: boolean; writable: boolean; etag?: string;
  busy: boolean; conflict: boolean; message: string; subscriptionWarning?: string;
};

/** Host URIs are opaque: only the host resources API may resolve or write them. */
export function createArtifactFileSession(resources: OpenAIResources | undefined, input: OpenAIFileEntrypointInput) {
  const uri = input.file.resourceUri;
  const supported = input.file.name.endsWith(".artifact.tsx");
  let state: ArtifactFileState = { draft: "", baseline: "", loaded: false, writable: false, busy: false, conflict: false, message: "Loading file…" };
  let disposed = false;
  let readVersion = 0;
  let saving = false;
  let refreshAfterSave = false;
  let subscribed = false;
  const listeners = new Set<() => void>();
  const dirty = () => state.draft !== state.baseline;
  const publish = (patch: Partial<ArtifactFileState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const externalConflict = () => publish({ conflict: true, message: "The file changed in the host. Your draft is preserved. Reload to discard your draft and read the latest file." });
  const read = async (discardDraft = false) => {
    if (!resources || !supported || disposed) return;
    if (!discardDraft && dirty()) { externalConflict(); return; }
    const version = ++readVersion;
    const originalDraft = state.draft;
    publish({ busy: true });
    try {
      const result = await resources.read({ uri, representation: "text" });
      if (disposed || version !== readVersion) return;
      // A user may type while an automatic refresh is in flight.
      if (state.draft !== originalDraft || (!discardDraft && dirty())) { publish({ busy: false }); externalConflict(); return; }
      const content = result.contents.find(item => item.uri === uri);
      if (!content) throw new Error("The host did not return the requested file.");
      let text: string;
      if ("text" in content && typeof content.text === "string") text = content.text;
      else if ("blob" in content && typeof content.blob === "string") {
        const bytes = Uint8Array.from(atob(content.blob), character => character.charCodeAt(0));
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } else throw new Error("The host returned no readable file content.");
      const metadata = content.openaiMetadata;
      const etag = metadata?.etag?.trim() ? metadata.etag : undefined;
      const writable = metadata?.writable === true && !!etag;
      publish({ draft: text, baseline: text, loaded: true, etag, writable, busy: false, conflict: false,
        message: writable ? "Ready. Changes are saved only when you choose Save." : "Read only. The host must grant write access and provide a version identifier to enable saving." });
    } catch (error) {
      if (version === readVersion) publish({ busy: false, message: `Unable to read file: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  let removeHandler: (() => void) | undefined;
  let subscription: Promise<void> = Promise.resolve();
  if (!supported) {
    publish({ message: "This editor supports only .artifact.tsx files." });
  } else if (!resources) {
    publish({ message: "File editing is unavailable because this host does not support managed resources." });
  } else {
    removeHandler = resources.addUpdateHandler(notification => {
      if (disposed || notification.params.uri !== uri) return;
      if (saving) { refreshAfterSave = true; return; }
      return read();
    });
    subscription = resources.subscribe({ uri }).then(() => { subscribed = true; }).catch(() => {
      publish({ subscriptionWarning: "Live file updates are unavailable. Reload to check for changes; saves still check the file version." });
    });
  }
  const ready = resources && supported ? read() : Promise.resolve();
  return {
    ready,
    canReload: !!resources && supported,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hasUnsavedChanges: dirty,
    edit(draft: string) { if (state.loaded && state.writable && !disposed) publish({ draft }); },
    reload() { if (saving || disposed) return Promise.resolve(); return read(true); },
    async save() {
      if (!resources || disposed || saving || state.busy || !state.writable || !state.etag || state.conflict || !dirty()) return;
      const draft = state.draft;
      const etag = state.etag;
      saving = true;
      publish({ busy: true, message: "Saving…" });
      try {
        const result = await resources.write(uri, { text: draft, ifMatch: etag });
        if (disposed) return;
        if (result.outcome === "saved") {
          const nextEtag = result.etag.trim() ? result.etag : undefined;
          publish({ baseline: draft, etag: nextEtag, writable: !!nextEtag, message: nextEtag ? "Saved." : "Saved. The host did not return a version identifier; further saves are disabled." });
        } else if (result.outcome === "conflict") externalConflict();
        else if ("maxBytes" in result) publish({ message: `The host rejected this file because it exceeds ${result.maxBytes} bytes. Your draft is preserved.` });
      } catch (error) {
        publish({ message: `Unable to save. Your draft is preserved. ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        saving = false;
        publish({ busy: false });
        if (refreshAfterSave && !disposed) { refreshAfterSave = false; await read(); }
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      ++readVersion;
      listeners.clear();
      removeHandler?.();
      await subscription;
      if (resources && subscribed) await resources.unsubscribe({ uri }).catch(() => {});
    },
  };
}

export function mountArtifactFileEditor(root: HTMLElement, extensions: OpenAIExtensions, input: OpenAIFileEntrypointInput): { dispose(): Promise<void>; hasUnsavedChanges(): boolean } {
  const session = createArtifactFileSession(extensions.resources, input);
  const reactRoot = createRoot(root);
  function Editor() {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const canSave = state.loaded && state.writable && !state.busy && !state.conflict && session.hasUnsavedChanges();
    return <div className="gallery-app mcp-file-editor"
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void session.save(); } }}
      >
      <style>{galleryStyles}{fileEditorStyles}</style>
      <header className="detail-header">
        <div className="detail-title"><p className="detail-eyebrow">Artifact file</p><h1>{input.file.name}</h1></div>
        <span className="muted">{session.hasUnsavedChanges() ? "Unsaved changes" : state.loaded ? state.writable ? "Saved" : "Read only" : ""}</span>
        <button className="primary-action" type="button" onClick={() => { void session.save(); }} disabled={!canSave} aria-keyshortcuts="Control+s Meta+s">Save</button>
        <button type="button" disabled={state.busy || !session.canReload} onClick={() => { void session.reload(); }}>
          {session.hasUnsavedChanges() ? "Discard draft and reload" : "Reload"}
        </button>
      </header>
      <p className="file-status" role="status" aria-live="polite">{state.message}</p>
      {state.subscriptionWarning && <p className="file-status" role="status">{state.subscriptionWarning}</p>}
      {state.loaded && <div className="file-source"><SourceEditor filename={input.file.name} value={state.draft} onChange={session.edit} readOnly={!state.writable} /></div>}
    </div>;
  }
  reactRoot.render(<Editor />);
  let unmounted = false;
  return { hasUnsavedChanges: session.hasUnsavedChanges, async dispose() { if (!unmounted) { unmounted = true; reactRoot.unmount(); } await session.dispose(); } };
}

const fileEditorStyles = `
.mcp-file-editor { height: 100%; min-height: 300px; background: var(--panel); color: var(--text); }
.mcp-file-editor .detail-header { flex-wrap: wrap; }
.mcp-file-editor .file-status { margin: 8px 16px; color: var(--muted); }
.mcp-file-editor .file-source { flex: 1; min-height: 0; overflow: auto; }
.mcp-file-editor .source-code-editor { display: flex; flex-direction: column; height: 100%; min-height: 180px; min-width: 0; }
.mcp-file-editor .source-code-surface { flex: 1; min-height: 0; min-width: 0; }
.mcp-file-editor .source-code-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 12px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; flex-shrink: 0; }
`;
