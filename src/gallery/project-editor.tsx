import { useState } from "react";

export type EditableProject = { files: Record<string, string>; dependencies: Record<string, string> };
export const emptyEditableProject = (): EditableProject => ({ files: {}, dependencies: {} });
export function editableProject(value: unknown): EditableProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Source response is missing the project snapshot.");
  const project = value as Record<string, unknown>;
  for (const field of ["files", "dependencies"] as const) {
    const entries = project[field];
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.values(entries).some(item => typeof item !== "string")) throw new Error(`Invalid project ${field}.`);
  }
  return { files: { ...project.files as Record<string, string> }, dependencies: { ...project.dependencies as Record<string, string> } };
}

export function ProjectEditor({ entries, project, onProjectChange, onEntryChange, readOnly = false, disabled = false, onValidityChange }: {
  entries: { id: string; label: string; source: string }[];
  project: EditableProject;
  onProjectChange: (project: EditableProject) => void;
  onEntryChange: (id: string, source: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  onValidityChange: (valid: boolean) => void;
}) {
  const [selection, setSelection] = useState(entries[0]?.id ?? "");
  const [filename, setFilename] = useState("");
  const [fileError, setFileError] = useState("");
  const [dependencies, setDependencies] = useState(JSON.stringify(project.dependencies, null, 2));
  const [dependencyError, setDependencyError] = useState("");
  const entry = entries.find(item => item.id === selection);
  const helper = selection.startsWith("file:") ? selection.slice(5) : null;
  const selectedSource = entry?.source ?? (helper === null ? "" : project.files[helper] ?? "");
  const locked = readOnly || disabled;
  function addFile() {
    const path = filename.trim();
    if (!/^[a-zA-Z0-9_./-]+\.(?:[cm]?[jt]sx?|json)$/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === "node_modules") || ["artifact.artifact.tsx", "artifact.artifact.server.ts", "script.ts", "entry.ts", "server-entry.ts", "package.json"].includes(path)) {
      setFileError("Use a relative .ts, .tsx, .js, or .json helper path, such as lib/helpers.ts."); return;
    }
    if (Object.hasOwn(project.files, path)) { setFileError("That file already exists."); return; }
    onProjectChange({ ...project, files: { ...project.files, [path]: "" } });
    setSelection(`file:${path}`); setFilename(""); setFileError("");
  }
  return <div className="project-editor">
    <div className="script-fields">
      <label>File <select aria-label="Project file" disabled={disabled} value={selection} onChange={event => setSelection(event.target.value)}>
        {entries.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        {Object.keys(project.files).sort().map(path => <option key={path} value={`file:${path}`}>{path}</option>)}
      </select></label>
      {!readOnly ? <><input aria-label="New helper file" placeholder="lib/helpers.ts" value={filename} disabled={disabled} onChange={event => setFilename(event.target.value)} /><button type="button" disabled={disabled || !filename.trim()} onClick={addFile}>Add file</button>
        {helper !== null ? <button type="button" disabled={disabled} onClick={() => { const files = { ...project.files }; delete files[helper]; onProjectChange({ ...project, files }); setSelection(entries[0]!.id); }}>Remove file</button> : null}</> : null}
    </div>
    {fileError ? <p role="alert" className="error-message">{fileError}</p> : null}
    <label className="source-editor-label">{entry?.label ?? helper}<textarea className="source-editor" aria-label={entry?.label ?? `Source of ${helper}`} spellCheck={false} readOnly={locked} value={selectedSource} onChange={event => {
      if (entry) onEntryChange(entry.id, event.target.value);
      else if (helper !== null) onProjectChange({ ...project, files: { ...project.files, [helper]: event.target.value } });
    }} /></label>
    <details><summary>Dependencies ({Object.keys(project.dependencies).length})</summary>
      <p className="muted">Use package names and exact versions, for example {`{"lodash-es": "4.17.21"}`}.</p>
      <label>Dependencies (JSON)<textarea aria-label="Project dependencies" spellCheck={false} readOnly={locked} value={dependencies} onChange={event => {
        const value = event.target.value; setDependencies(value);
        try {
          const parsed: unknown = JSON.parse(value);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.entries(parsed).some(([name, version]) => !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))) throw new Error("Enter a JSON object mapping package names to exact versions.");
          onProjectChange({ ...project, dependencies: parsed as Record<string, string> }); setDependencyError(""); onValidityChange(true);
        } catch (error) { setDependencyError(error instanceof Error ? error.message : String(error)); onValidityChange(false); }
      }} /></label>
      {dependencyError ? <p role="alert" className="error-message">{dependencyError}</p> : null}
    </details>
  </div>;
}
