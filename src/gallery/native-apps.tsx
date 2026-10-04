import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { GalleryToolError, galleryTool } from "./hosted";
import { ProjectEditor, editableProject, emptyEditableProject, type EditableProject } from "./project-editor";
import { SecretControls } from "./secrets";
import { Select } from "./select";
import { Tabs } from "@base-ui/react/tabs";
import type { AppManifest } from "../../cloudflare/native-worker/manifest";

type App = {
  name: string;
  provider: string;
  status: string;
  error?: string;
  active_revision?: string;
  desired_revision?: string;
  revision_token: string;
};
type Snapshot = App & { source: string; manifest: AppManifest; project: EditableProject };
const initialManifest = {
  main: "worker.ts",
  compatibility_date: "2026-09-06",
  compatibility_flags: ["nodejs_compat"],
  vars: {},
  secrets: [],
  bindings: {},
  triggers: { crons: [], queues: [] },
};
const initialSource = 'export default { fetch(request: Request) { return new Response("Hello from your Worker"); } };';
const decode = <T,>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export type NativeAppEditorHandle = { canLeave: () => boolean };

export function NativeAppEditor({ workspace, appName, providers, onNavigate, onSaved, onBack, hidden, ref }: {
  workspace: string; appName: string | null; providers: string[];
  onNavigate: (name: string | null) => void; onSaved: () => Promise<void>; onBack: () => void;
  hidden: boolean; ref: Ref<NativeAppEditorHandle>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [section, setSection] = useState(workerSection());
  const [creating, setCreating] = useState(!appName),
    [editingNew, setEditingNew] = useState(false);
  const [template, setTemplate] = useState("http");
  function navigate(app: string | null, tab = section) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "workers");
    url.searchParams.set("workspace", workspace);
    if (app) {
      url.searchParams.set("app", app);
      url.searchParams.set("appTab", tab);
    } else {
      url.searchParams.delete("view");
      url.searchParams.delete("app");
      url.searchParams.delete("appTab");
    }
    window.history.pushState(null, "", url);
    setSection(tab);
    onNavigate(app);
  }
  const [selected, setSelected] = useState<App | null>(null),
    [name, setName] = useState("");
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [provider, setProvider] = useState(providers[0] ?? ""),
    [source, setSource] = useState(initialSource);
  const [manifest, setManifest] = useState(JSON.stringify(initialManifest, null, 2));
  const [project, setProject] = useState(emptyEditableProject),
    [dependencies, setDependencies] = useState("{}");
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [valid, setValid] = useState(true);
  const [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [revisions, setRevisions] = useState<{ id: string; created_at: string }[]>([]),
    [restoreId, setRestoreId] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const library = new URLSearchParams(window.location.search).get("library") === "team" ? "team" : "private";
  const allowLeave = () => !dirty || window.confirm("Discard unsaved Worker app changes?");
  useImperativeHandle(ref, () => ({ canLeave: () => !busy && allowLeave() }));
  useEffect(() => {
    setSection(workerSection());
    if (appName && appName !== selected?.name) {
      setSelected(null);
      setDirty(false);
      void perform(() => loadApp(appName));
    }
  }, [workspace, appName]);
  useEffect(() => {
    if (!hidden) heading.current?.focus({ preventScroll: true });
  }, [hidden, appName]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  useEffect(() => {
    const listener = () => setSection(workerSection());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  async function perform(action: () => Promise<void>, editorMatchesDraft = false, preserveDraft = false) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (error) {
      if (error instanceof GalleryToolError && error.result?.applied) {
        if (editorMatchesDraft) {
          setDirty(false);
          setSelected(error.result as App);
          setBaseRevision(error.result.revision_token ?? null);
          navigate(name);
        } else if (preserveDraft) setSelected(error.result as App);
        else await loadApp(name);
        await onSaved();
      }
      const diagnostics = error instanceof GalleryToolError ? error.result?.diagnostics : undefined;
      setError(
        diagnostics?.length
          ? diagnostics.map((item) => item.message).join("\n")
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setBusy(false);
    }
  }
  async function loadApp(name: string) {
    const saved = decode<Snapshot>(await galleryTool(workspace, "app_read", { name }));
    setCreating(false);
    setEditingNew(false);
    setSelected(saved);
    setBaseRevision(saved.revision_token);
    setName(saved.name);
    setProvider(saved.provider);
    setSource(saved.source);
    setManifest(JSON.stringify(saved.manifest, null, 2));
    setProject(editableProject(saved.project));
    setDependencies(JSON.stringify(saved.project.dependencies, null, 2));
    setDirty(false);
    setEditorKey((value) => value + 1);
    let offset = 0;
    const revisions: { id: string; created_at: string }[] = [];
    for (;;) {
      const history = decode<{ revisions: { id: string; created_at: string }[]; next_offset: number | null }>(
        await galleryTool(workspace, "app_history", { name, offset }),
      );
      revisions.push(...history.revisions);
      if (history.next_offset === null) break;
      if (history.next_offset <= offset) throw new Error("Invalid app history pagination");
      offset = history.next_offset;
    }
    setRevisions(revisions);
    setRestoreId(revisions[0]?.id ?? "");
  }
  const appUrl =
    selected?.status === "active"
      ? (() => {
          const params = new URLSearchParams({ workspace });
          const library = new URLSearchParams(window.location.search).get("library");
          if (library) params.set("library", library);
          return `/apps/${encodeURIComponent(selected.name)}/?${params}`;
        })()
      : null;
  let parsed: AppManifest | null = null;
  try {
    const value = JSON.parse(manifest);
    if (isEditableManifest(value)) parsed = value;
  } catch {
    /* Keep invalid JSON editable in the advanced editor. */
  }
  const updateManifest = (patch: Partial<AppManifest>) => {
    setManifest(JSON.stringify({ ...parsed, ...patch }, null, 2));
    setDirty(true);
  };
  const providerAvailable = providers.includes(provider);
  const detail = (!!selected || editingNew) && providerAvailable;
  return (
    <Tabs.Root
      render={<section />}
      aria-label="Worker apps"
      className="artifact-detail worker-workspace"
      hidden={hidden}
      value={section}
      onValueChange={(value) => {
        const tab = value as WorkerSection;
        setSection(tab);
        if (selected) navigate(selected.name, tab);
      }}
    >
      <style>{`
        .worker-workspace .worker-content { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; }
        .worker-workspace .source-form { flex-shrink: 0; min-height: auto; }
        .worker-workspace [role="tabpanel"] { flex: 1; min-width: 0; padding: 16px; }
        .worker-workspace [role="tabpanel"][hidden] { display: none; }
        .worker-workspace .worker-source-panel { min-height: 300px; padding: 0; }
        .worker-workspace .worker-source-panel > .project-editor { height: 100%; }
        .worker-workspace .worker-content > :is(p, .worker-empty, .script-fields, h3, button) { margin: 12px 16px; }
        .worker-workspace .source-actions { flex-wrap: wrap; }
        .worker-workspace input, .worker-workspace textarea { max-width: 100%; box-sizing: border-box; }
        .worker-workspace fieldset { min-width: 0; }
        .worker-workspace .script-fields > label { max-width: 100%; }
        .worker-workspace .detail-actions .open-link { display: inline-flex; }
        @media (max-width: 1100px) {
          .worker-workspace .detail-header { flex-wrap: wrap; gap: 8px; }
          .worker-workspace .view-control { order: 3; width: 100%; }
        }
      `}</style>
      <header className="detail-header">
        <button className="back-library" type="button" onClick={onBack} aria-label="Back to library"><span aria-hidden="true">←</span></button>
        <div className="detail-title">
          <h1 ref={heading} tabIndex={-1}>{appName || name || "New Worker app"}</h1>
        </div>
        {detail ? <Tabs.List aria-label="Worker app sections" className="view-control" activateOnFocus>
          {workerSections.map(tab => <Tabs.Tab key={tab} value={tab} type="button">{tab[0]!.toUpperCase() + tab.slice(1)}</Tabs.Tab>)}
        </Tabs.List> : null}
        {appUrl ? <div className="detail-actions"><a className="download-link open-link" aria-label="Open private app" href={appUrl} target="_blank" rel="noopener">Open<span aria-hidden="true">↗</span></a></div> : null}
      </header>
      <div className="worker-content">
        {error ? (
          <p role="alert" className="error-message" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </p>
        ) : null}
        {status ? <p role="status">{status}</p> : null}
        {appName && !selected && busy ? <p role="status">Loading Worker app…</p> : null}
        {selected && !providerAvailable ? (
          <p role="status">
            {selected.name} uses {selected.provider}, which is not available on this deployment. Configure that provider
            to edit or deploy this app.
          </p>
        ) : null}
        {!providers.length ? (
          <div className="worker-empty">
            <h2>Worker apps are unavailable</h2>
            <p>
              No Worker app provider is available on this deployment. Configure a provider to create and deploy Workers.
            </p>
            <a href="https://github.com/sidequery/artifacts/blob/main/docs/native-workers.md">
              Worker setup documentation
            </a>
          </div>
        ) : null}
        {creating && providers.length ? (
          <form
            className="source-form"
            onSubmit={(event) => {
              event.preventDefault();
              setCreating(false);
              setEditingNew(true);
              setDirty(true);
              setSource(
                template === "scheduled"
                  ? 'export default { async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext) { console.log("Scheduled Worker", event.cron); } };'
                  : initialSource,
              );
            }}
          >
            <h2>New Worker app</h2>
            <div className="script-fields">
              <label>
                Name
                <input
                  aria-label="Worker app name"
                  value={name}
                  required
                  onChange={(event) => { setName(event.target.value); setDirty(true); }}
                />
              </label>
              {providers.length === 1 ? (
                <p>Provider: {providers[0]}</p>
              ) : (
                <label>
                  Provider
                  <Select
                    aria-label="Worker app provider"
                    value={provider}
                    onChange={(event) => { setProvider(event.target.value); setDirty(true); }}
                  >
                    {providers.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                Template
                <Select
                  aria-label="Worker app template"
                  value={template}
                  onChange={(event) => { setTemplate(event.target.value); setDirty(true); }}
                >
                  <option value="http">HTTP Worker</option>
                  <option value="scheduled">Scheduled Worker</option>
                </Select>
              </label>
            </div>
            <div className="source-actions">
              <button className="primary-action">Continue to editor</button>
              <button type="button" onClick={onBack}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
        {detail ? (
          <>
            <div className="script-fields">
              <span>{provider}</span>
              {selected ? (
                <span role="status">
                  Deployment: {selected.status.replaceAll("-", " ")}
                  {` · saved ${selected.revision_token.slice(0, 12)}`}
                  {selected.desired_revision ? ` · desired ${selected.desired_revision.slice(0, 12)}` : ""}
                  {selected.active_revision ? ` · active ${selected.active_revision.slice(0, 12)}` : ""}
                </span>
              ) : (
                <span>New draft</span>
              )}
            </div>
            {selected?.error ? <p role="alert">{selected.error}</p> : null}
            <form
              className="source-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const result = decode<App & { ok: boolean }>(
                    await galleryTool(workspace, "app_write", {
                      name,
                      source,
                      manifest: JSON.parse(manifest),
                      project,
                      provider,
                      expected_revision: baseRevision,
                    }),
                  );
                  setDirty(false);
                  await onSaved();
                  await loadApp(name);
                  navigate(name);
                  setStatus(result.ok ? "Worker app deployed" : "Worker app needs reconciliation");
                }, true);
              }}
            >
              <Tabs.Panel value="source" className="worker-source-panel" keepMounted hidden={section !== "source"}>
                <ProjectEditor
                  key={editorKey}
                  entries={[{ id: "worker", filename: parsed?.main || "worker.ts", source }]}
                  project={project}
                  onEntryChange={(_, value) => {
                    setSource(value);
                    setDirty(true);
                  }}
                  onProjectChange={(value) => {
                    setProject(value);
                    setDirty(true);
                  }}
                  dependencyText={dependencies}
                  onDependencyTextChange={(value) => {
                    setDependencies(value);
                    setDirty(true);
                  }}
                  onValidityChange={setValid}
                  disabled={busy}
                />
              </Tabs.Panel>
              <Tabs.Panel value="resources">
                <h2>Resources</h2>
                <p className="muted">
                  Bindings expose persistent resources to your Worker. Keep resource names stable to retain their
                  identity. Removing a binding retains stored data.
                </p>
                {parsed ? (
                  <ManifestResources manifest={parsed} update={updateManifest} disabled={busy} />
                ) : (
                  <p>Fix the manifest JSON in Settings to edit resources.</p>
                )}
              </Tabs.Panel>
              <Tabs.Panel value="triggers">
                <h2>Triggers</h2>
                <p className="muted">
                  Cron triggers use UTC. Queue consumers refer to queue resource names configured in Resources.
                </p>
                {parsed ? (
                  <>
                    <StringList
                      label="Cron schedule"
                      values={parsed.triggers?.crons ?? []}
                      disabled={busy}
                      onChange={(crons) =>
                        updateManifest({
                          triggers: { ...parsed!.triggers, crons, queues: parsed!.triggers?.queues ?? [] },
                        })
                      }
                    />
                    <StringList
                      label="Queue consumer"
                      values={parsed.triggers?.queues ?? []}
                      disabled={busy}
                      onChange={(queues) =>
                        updateManifest({
                          triggers: { ...parsed!.triggers, queues, crons: parsed!.triggers?.crons ?? [] },
                        })
                      }
                    />
                  </>
                ) : (
                  <p>Fix the manifest JSON in Settings to edit triggers.</p>
                )}
              </Tabs.Panel>
              <Tabs.Panel value="deployments">
                <h2>Deployments</h2>
                {selected ? (
                  <>
                    <p>
                      Desired revision: {selected.desired_revision?.slice(0, 12) || "None"} · Active revision:{" "}
                      {selected.active_revision?.slice(0, 12) || "None"}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          async () => {
                            await galleryTool(workspace, "app_reconcile", { name });
                            await onSaved();
                            setSelected(decode<Snapshot>(await galleryTool(workspace, "app_read", { name })));
                            setStatus("Deployment reconciled");
                          },
                          false,
                          true,
                        )
                      }
                    >
                      {["active", "draft"].includes(selected.status) ? "Reconcile deployment" : "Retry deployment"}
                    </button>
                    <h3>Revision history</h3>
                    <p>
                      Restore and deploy a saved source revision. Resource data is retained; this does not roll back
                      stored data.
                    </p>
                    <div className="script-fields">
                      <label>
                        Revision
                        <Select
                          aria-label="Worker app revision"
                          value={restoreId}
                          disabled={busy}
                          onChange={(event) => setRestoreId(event.target.value)}
                        >
                          {revisions.map((revision) => (
                            <option key={revision.id} value={revision.id}>
                              {revision.id.slice(0, 12)} · {revision.created_at}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <button
                        type="button"
                        disabled={busy || !restoreId}
                        onClick={() => {
                          if (allowLeave())
                            void perform(async () => {
                              await galleryTool(workspace, "app_restore", { name, revision_id: restoreId });
                              await onSaved();
                              await loadApp(name);
                              setStatus("Source restored and deployed; data retained");
                            });
                        }}
                      >
                        Restore and deploy
                      </button>
                    </div>
                  </>
                ) : (
                  <p>Save and deploy this Worker to create its first revision.</p>
                )}
              </Tabs.Panel>
              <Tabs.Panel value="settings">
                <h2>Settings</h2>
                {parsed ? (
                  <>
                    <div className="script-fields">
                      <label>
                        Entry point
                        <input
                          aria-label="Worker entry point"
                          disabled={busy}
                          value={parsed.main ?? ""}
                          onChange={(event) => updateManifest({ main: event.target.value })}
                        />
                      </label>
                      <label>
                        Compatibility date
                        <input
                          aria-label="Compatibility date"
                          type="date"
                          disabled={busy}
                          value={parsed.compatibility_date ?? ""}
                          onChange={(event) => updateManifest({ compatibility_date: event.target.value })}
                        />
                      </label>
                    </div>
                    <StringList
                      label="Compatibility flag"
                      values={parsed.compatibility_flags ?? []}
                      disabled={busy}
                      onChange={(compatibility_flags) => updateManifest({ compatibility_flags })}
                    />
                    <VariableFields
                      values={parsed.vars ?? {}}
                      disabled={busy}
                      onChange={(vars) => updateManifest({ vars })}
                    />
                    <StringList
                      label="Required secret"
                      values={parsed.secrets ?? []}
                      disabled={busy}
                      onChange={(secrets) => updateManifest({ secrets })}
                    />
                  </>
                ) : (
                  <p role="alert">Enter a valid manifest object below to use structured settings.</p>
                )}
                <details>
                  <summary>Advanced manifest (JSON)</summary>
                  <label>
                    Manifest
                    <textarea
                      aria-label="Worker app manifest"
                      rows={16}
                      value={manifest}
                      disabled={busy}
                      onChange={(event) => {
                        setManifest(event.target.value);
                        setDirty(true);
                      }}
                      style={{ width: "100%", background: "var(--page)", border: "1px solid var(--line)", padding: 12 }}
                    />
                  </label>
                </details>
              </Tabs.Panel>
              <div className="source-actions">
                <button className="primary-action" disabled={busy || !valid || !provider || !parsed}>
                  Save and deploy Worker
                </button>
                {dirty ? <span>Unsaved changes</span> : null}
              </div>
            </form>
            {section === "settings" && selected ? (
              <>
                <h3>Secret values</h3>
                <SecretControls
                  key={selected.name}
                  workspace={workspace}
                  name={selected.name}
                  kind="app"
                  onSaved={async () => {
                    await onSaved();
                    const saved = decode<Snapshot>(await galleryTool(workspace, "app_read", { name }));
                    setSelected(saved);
                  }}
                />
                <h3>Library</h3>
                <button
                  disabled={busy || dirty}
                  onClick={() =>
                    void perform(async () => {
                      await galleryTool(workspace, "app_move", {
                        name,
                        library: library === "team" ? "private" : "team",
                      });
                      setSelected(null);
                      setEditingNew(false);
                      navigate(null);
                      await onSaved();
                    })
                  }
                >
                  Move to {library === "team" ? "personal" : "team"} library
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Tabs.Root>
  );
}

const workerSections = ["source", "resources", "triggers", "deployments", "settings"] as const;
type WorkerSection = (typeof workerSections)[number];
function workerSection(): WorkerSection {
  const value = new URLSearchParams(window.location.search).get("appTab");
  return workerSections.includes(value as WorkerSection) ? (value as WorkerSection) : "source";
}
// Validate the editor shape without importing the server manifest parser (node:crypto).
// Invalid raw JSON stays editable and never crashes the structured controls.
function isEditableManifest(value: unknown): value is AppManifest {
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const strings = (item: unknown) =>
    item === undefined || (Array.isArray(item) && item.every((value) => typeof value === "string"));
  if (!record(value) || typeof value.main !== "string" || typeof value.compatibility_date !== "string") return false;
  if (!strings(value.compatibility_flags) || !strings(value.secrets)) return false;
  if (
    value.vars !== undefined &&
    (!record(value.vars) || Object.values(value.vars).some((item) => typeof item !== "string"))
  )
    return false;
  if (
    value.bindings !== undefined &&
    (!record(value.bindings) ||
      Object.values(value.bindings).some(
        (item) =>
          !record(item) ||
          !["kv", "r2", "d1", "queue", "durable-object"].includes(String(item.type)) ||
          typeof item.resource !== "string" ||
          (item.type === "durable-object" && typeof item.class_name !== "string"),
      ))
  )
    return false;
  return (
    value.triggers === undefined ||
    (record(value.triggers) && strings(value.triggers.crons) && strings(value.triggers.queues))
  );
}
function StringList({
  label,
  values,
  disabled,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: "12px 0" }}>
      <legend>{label}s</legend>
      {values.map((value, index) => (
        <div className="script-fields" key={index}>
          <input
            aria-label={`${label} ${index + 1}`}
            value={value}
            onChange={(event) => onChange(values.map((item, i) => (i === index ? event.target.value : item)))}
          />
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...values, ""])}>
        Add {label.toLowerCase()}
      </button>
    </fieldset>
  );
}
function VariableFields({
  values,
  disabled,
  onChange,
}: {
  values: Record<string, string>;
  disabled: boolean;
  onChange: (values: Record<string, string>) => void;
}) {
  const rows = Object.entries(values);
  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: "12px 0" }}>
      <legend>Environment variables</legend>
      {rows.map(([name, value], index) => (
        <div className="script-fields" key={index}>
          <input
            aria-label={`Variable name ${index + 1}`}
            value={name}
            onChange={(event) => {
              if (event.target.value !== name && Object.hasOwn(values, event.target.value)) return;
              onChange(Object.fromEntries(rows.map((row, i) => (i === index ? [event.target.value, value] : row))));
            }}
          />
          <input
            aria-label={`Variable value ${index + 1}`}
            value={value}
            onChange={(event) => onChange({ ...values, [name]: event.target.value })}
          />
          <button type="button" onClick={() => onChange(Object.fromEntries(rows.filter((_, i) => i !== index)))}>
            Remove variable
          </button>
        </div>
      ))}
      <button type="button" disabled={Object.hasOwn(values, "")} onClick={() => onChange({ ...values, "": "" })}>
        Add variable
      </button>
    </fieldset>
  );
}
function ManifestResources({
  manifest,
  update,
  disabled,
}: {
  manifest: AppManifest;
  update: (patch: Partial<AppManifest>) => void;
  disabled: boolean;
}) {
  const bindings = manifest.bindings ?? {},
    rows = Object.entries(bindings);
  const change = (index: number, name: string, binding: AppManifest["bindings"][string]) =>
    update({ bindings: Object.fromEntries(rows.map((row, i) => (i === index ? [name, binding] : row))) });
  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
      {rows.map(([name, binding], index) => (
        <div key={index} style={{ padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
          <div className="script-fields">
            <label>
              Binding name
              <input
                aria-label={`Binding name ${index + 1}`}
                value={name}
                onChange={(event) => {
                  if (event.target.value !== name && Object.hasOwn(bindings, event.target.value)) return;
                  change(index, event.target.value, binding);
                }}
              />
            </label>
            <label>
              Type
              <Select
                aria-label={`Binding type ${index + 1}`}
                value={binding.type}
                onChange={(event) => {
                  const type = event.target.value as typeof binding.type;
                  change(
                    index,
                    name,
                    type === "durable-object"
                      ? {
                          type,
                          resource: binding.resource,
                          class_name: "class_name" in binding ? binding.class_name : "",
                        }
                      : { type, resource: binding.resource },
                  );
                }}
              >
                {["kv", "r2", "d1", "queue", "durable-object"].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </Select>
            </label>
            <label>
              Resource name
              <input
                aria-label={`Resource name ${index + 1}`}
                value={binding.resource}
                onChange={(event) => change(index, name, { ...binding, resource: event.target.value })}
              />
            </label>
            {binding.type === "durable-object" ? (
              <label>
                Class export
                <input
                  aria-label={`Class export ${index + 1}`}
                  value={binding.class_name}
                  onChange={(event) => change(index, name, { ...binding, class_name: event.target.value })}
                />
              </label>
            ) : null}
            <button
              type="button"
              onClick={() => update({ bindings: Object.fromEntries(rows.filter((_, i) => i !== index)) })}
            >
              Remove binding
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={Object.hasOwn(bindings, "")}
        onClick={() => update({ bindings: { ...bindings, "": { type: "kv", resource: "" } } })}
      >
        Add binding
      </button>
    </fieldset>
  );
}
