import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { editableProject, type EditableProject } from "./project-editor";

export type SourceSnapshot = { source: string; server_source?: string | null; project: EditableProject; revision_token?: string };
export type DraftContent = SourceSnapshot & { name?: string; slug?: string; access?: "private" | "public" };
export type EditorDraft = {
  content: DraftContent;
  dependencyText: string;
  baseline: string;
  dirty: boolean;
};

function signature(content: DraftContent, dependencyText: string): string {
  const { revision_token, ...editable } = content;
  return JSON.stringify([editable, dependencyText]);
}

type DraftContext = {
  drafts: Map<string, EditorDraft>;
  set: (key: string, update: (current: EditorDraft | undefined) => EditorDraft | undefined) => void;
};
const Drafts = createContext<DraftContext | null>(null);

/** Buffers belong to the gallery session, rather than the selected editor panel. */
export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState(new Map<string, EditorDraft>());
  const set = useCallback<DraftContext["set"]>((key, update) => {
    setDrafts(current => {
      const value = update(current.get(key));
      const next = new Map(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }, []);
  const dirty = [...drafts.values()].some(draft => draft.dirty);
  useEffect(() => {
    if (!dirty) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [dirty]);
  return <Drafts.Provider value={{ drafts, set }}>{children}</Drafts.Provider>;
}

export function useDrafts() {
  const context = useContext(Drafts);
  if (!context) throw new Error("Gallery drafts require DraftProvider");
  return context;
}

export function useProjectDraft(key: string) {
  const { drafts, set } = useDrafts();
  const draft = drafts.get(key);
  const reset = useCallback((content: DraftContent) => {
    const dependencyText = JSON.stringify(content.project.dependencies, null, 2);
    set(key, () => ({ content, dependencyText, baseline: signature(content, dependencyText), dirty: false }));
  }, [key, set]);
  const update = (change: Partial<DraftContent>, dependencyText?: string) => set(key, current => {
    if (!current) return current;
    const content = { ...current.content, ...change };
    const text = dependencyText ?? current.dependencyText;
    return { ...current, content, dependencyText: text, dirty: signature(content, text) !== current.baseline };
  });
  const saved = (revision_token?: string) => set(key, current => {
    if (!current) return current;
    const content = { ...current.content, revision_token: revision_token ?? current.content.revision_token };
    return { ...current, content, baseline: signature(content, current.dependencyText), dirty: false };
  });
  return { draft, reset, update, saved, clear: () => set(key, () => undefined),
    invalidateClean: (otherKey: string) => set(otherKey, current => current?.dirty ? current : undefined) };
}

export async function loadSourceSnapshot(sourceUrl: string, signal?: AbortSignal): Promise<SourceSnapshot> {
  const url = new URL(sourceUrl, window.location.href);
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Source request failed (${response.status})`);
  const value = await response.json() as SourceSnapshot;
  if (typeof value.source !== "string" || (value.server_source !== undefined && value.server_source !== null && typeof value.server_source !== "string")) throw new Error("Invalid source snapshot.");
  return { ...value, project: editableProject(value.project) };
}

export function confirmLeavingDrafts(drafts: Map<string, EditorDraft>): boolean {
  return ![...drafts.values()].some(draft => draft.dirty)
    || window.confirm("You have unsaved project changes. Leaving this gallery will discard those changes. Leave anyway?");
}
