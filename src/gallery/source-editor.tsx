import { useEffect, useId, useRef } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

const externalChange = Annotation.define<boolean>();
const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#aebddd" },
  { tag: [tags.string, tags.special(tags.string)], color: "#b6c6a0" },
  { tag: [tags.number, tags.bool, tags.null], color: "#d1b58e" },
  { tag: [tags.comment], color: "#858b91", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#a8c9c4" },
  { tag: [tags.function(tags.variableName), tags.attributeName], color: "#c6bfd5" },
]);
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "#d8dcdf", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0", caretColor: "#e3e6e8" },
  ".cm-line": { padding: "0 20px 0 12px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "#697078", border: "none", padding: "0 8px 0 12px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#394553" },
  ".cm-cursor": { borderLeftColor: "#e3e6e8" },
  ".cm-panels": { backgroundColor: "#202326", color: "#d8dcdf" },
  ".cm-search": { padding: "8px 12px" },
  ".cm-textfield": { background: "#17191b", color: "inherit", border: "1px solid #45494d", borderRadius: "0" },
  ".cm-button": { background: "#2b2e31", color: "inherit", border: "1px solid #45494d", borderRadius: "0" },
}, { dark: true });

/** One view, with a separate document, selection, and undo history for each file. */
export function SourceEditor({ filename, value, onChange, readOnly = false, disabled = false }: {
  filename: string; value: string; onChange: (value: string) => void; readOnly?: boolean; disabled?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const shortcutsId = useId();
  const view = useRef<EditorView | null>(null);
  const buffers = useRef(new Map<string, EditorState>());
  const active = useRef<string | null>(null);
  const callback = useRef(onChange);
  const access = useRef(new Compartment());
  callback.current = onChange;
  useEffect(() => {
    const editor = new EditorView({ parent: host.current!, state: EditorState.create() });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; buffers.current.clear(); active.current = null; };
  }, []);
  useEffect(() => {
    const editor = view.current!;
    if (active.current !== null) buffers.current.set(active.current, editor.state);
    active.current = filename;
    const accessibility = [EditorState.readOnly.of(readOnly || disabled), EditorView.editable.of(!disabled), EditorView.contentAttributes.of({ "aria-label": filename, "aria-readonly": String(readOnly || disabled), "aria-disabled": String(disabled), "aria-describedby": shortcutsId, role: "textbox", "aria-multiline": "true" })];
    let state = buffers.current.get(filename);
    if (!state) state = EditorState.create({ doc: value, extensions: [
      EditorState.allowMultipleSelections.of(true), lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(),
      filename.endsWith(".json") ? json() : javascript({ jsx: /[jt]sx$/.test(filename), typescript: /\.[cm]?tsx?$/.test(filename) }),
      syntaxHighlighting(colors), theme, search({ top: true }), access.current.of(accessibility),
      keymap.of([{ key: "Mod-Enter", run: current => { if (!current.state.readOnly) current.dom.closest("form")?.requestSubmit(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of(update => { if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) callback.current(update.state.doc.toString()); }),
    ] });
    editor.setState(state);
    editor.dispatch({ effects: access.current.reconfigure(accessibility) });
    if (editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: [externalChange.of(true)] });
  }, [filename, readOnly, disabled]);
  useEffect(() => {
    const editor = view.current!;
    if (editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: [externalChange.of(true)] });
  }, [value]);
  return <div className="source-code-editor">
    <div ref={host} className="source-code-surface" />
    <div className="source-code-status"><span className="editor-shortcuts" id={shortcutsId}>Tab to indent · Esc then Tab to leave · ⌘/Ctrl F to find</span><button type="button" onClick={() => { if (view.current) openSearchPanel(view.current); }}>Find</button></div>
  </div>;
}
