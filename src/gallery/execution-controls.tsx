import { useEffect, useState } from "react";
import { Select } from "./select";
import { encodeRequestBody, galleryTool, parseRequestHeaders } from "./hosted";
import { nextOccurrence, normalizeTiming } from "../../cloudflare/schedule";

type Schedule = { interval_seconds?: number; cron?: string; timezone?: string; paused: boolean; next_run_at: number | null; request: { path: string; method: string; headers: [string, string][]; body?: string } };
type Run = { id: string; revision: string; trigger: string; started_at: string; duration_ms: number | null; status: string; http_status: number | null };
const unpack = (value: unknown): { schedule: Schedule | null; runs: Run[]; has_server?: boolean } => typeof value === "string" ? JSON.parse(value) : value as { schedule: Schedule | null; runs: Run[]; has_server?: boolean };
const units = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
type Unit = keyof typeof units;

export function ExecutionControls({ workspace, name, kind = "script", active = true }: { workspace: string; name: string; kind?: "script" | "artifact"; active?: boolean }) {
  const [hasServer, setHasServer] = useState(true);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState("interval");
  const [interval, setInterval] = useState("1"), [unit, setUnit] = useState<Unit>("hours");
  const [cron, setCron] = useState("0 * * * *"), [timezone, setTimezone] = useState("UTC");
  const [path, setPath] = useState("/"), [method, setMethod] = useState("GET");
  const [headers, setHeaders] = useState("{}"), [originalHeaders, setOriginalHeaders] = useState<[string, string][] | null>(null);
  const [body, setBody] = useState("");
  const [runs, setRuns] = useState<Run[]>([]), [logs, setLogs] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);

  async function perform(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function timing() { return normalizeTiming(mode === "interval" ? { interval_seconds: Number(interval) * units[unit] } : { cron, timezone }); }
  async function control(action: string) {
    const request = action === "set" ? { path, method, headers: originalHeaders ?? parseRequestHeaders(headers), ...(method !== "GET" && method !== "HEAD" && body ? { body: encodeRequestBody(body) } : {}) } : undefined;
    if (request && !path.startsWith("/")) throw new Error("Path must start with /.");
    const result = unpack(await galleryTool(workspace, `${kind}_schedule`, { name, action, ...(action === "set" ? { ...timing(), request } : {}) }));
    setSchedule(result.schedule); setLoaded(true);
    if (result.has_server !== undefined) setHasServer(result.has_server);
    if (action === "get") {
      const current = result.schedule;
      const seconds = current?.interval_seconds ?? 3600;
      const nextUnit = (["days", "hours", "minutes", "seconds"] as Unit[]).find(value => seconds % units[value] === 0)!;
      setMode(current?.cron ? "cron" : "interval"); setUnit(nextUnit); setInterval(String(seconds / units[nextUnit]));
      setCron(current?.cron ?? "0 * * * *"); setTimezone(current?.timezone ?? "UTC");
      setPath(current?.request.path ?? "/"); setMethod(current?.request.method ?? "GET");
      setOriginalHeaders(current?.request.headers ?? null);
      setHeaders(JSON.stringify(Object.fromEntries(current?.request.headers ?? []), null, 2));
      setBody(current?.request.body ? new TextDecoder().decode(Uint8Array.from(atob(current.request.body), character => character.charCodeAt(0))) : "");
    }
  }
  async function loadRuns() {
    setRuns(unpack(await galleryTool(workspace, `${kind}_runs`, { name })).runs ?? []);
    setRunsLoaded(true);
  }
  useEffect(() => {
    if (!active || loaded) return;
    void perform(async () => { await control("get"); await loadRuns(); });
  }, [active, workspace, name]);
  const displayTime = (value: number | string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " (UTC)";
  let preview = "";
  if (loaded) { try { preview = `Next run if saved now: ${displayTime(nextOccurrence(timing()))}`; } catch (error) { preview = error instanceof Error ? error.message : String(error); } }
  let frequency = "";
  if (schedule?.interval_seconds) {
    const displayUnit = (["days", "hours", "minutes", "seconds"] as Unit[]).find(value => schedule.interval_seconds! % units[value] === 0)!;
    const amount = schedule.interval_seconds / units[displayUnit];
    frequency = amount === 1 ? `Every ${displayUnit.slice(0, -1)}` : `Every ${amount} ${displayUnit}`;
  }
  const duplicates = originalHeaders && new Set(originalHeaders.map(([key]) => key.toLowerCase())).size < originalHeaders.length;
  return <>
    {error ? <p role="alert">{error}</p> : null}
    <section className="schedule-summary" aria-label="Schedule status">
      <h2>Schedule</h2>
      {!loaded ? <p role="status">{busy ? "Loading schedule…" : "Load current settings before editing."}</p> : <>
        <p role="status"><strong>{schedule ? schedule.paused ? "Paused" : "Enabled" : "Not configured"}</strong></p>
        {schedule ? <p>{schedule.cron ? `${schedule.cron} · ${schedule.timezone ?? "UTC"}` : frequency} · {schedule.next_run_at === null ? "No next run" : `Next run: ${displayTime(schedule.next_run_at)}`}</p> : null}
        {runs[0] ? <p>Last result: {runs[0].status} · {displayTime(runs[0].started_at)}</p> : null}
      </>}
      <button disabled={busy} onClick={() => void perform(() => control("get"))}>{loaded ? "Reload schedule" : "Load schedule"}</button>
      {schedule ? <><button disabled={busy || !hasServer && schedule.paused} onClick={() => void perform(() => control(schedule.paused ? "resume" : "pause"))}>{schedule.paused ? "Resume schedule" : "Pause schedule"}</button><button disabled={busy || !hasServer} onClick={() => void perform(async () => { await control("run_now"); await loadRuns(); })}>Run schedule now</button></> : null}
    </section>
    {loaded && !hasServer ? <p role="status">This artifact has no validated server. Add and deploy a server handler in Source to schedule requests.</p> : <details className="schedule-form" open><summary>{schedule ? "Edit schedule" : "Create schedule"}</summary>
      <form onSubmit={event => { event.preventDefault(); if (loaded && !busy) void perform(() => control("set")); }}>
        <fieldset disabled={!loaded || busy}>
          <div className="script-fields">
          <label>Repeat <Select aria-label="Schedule mode" value={mode} onChange={event => setMode(event.target.value)}><option value="interval">Interval</option><option value="cron">Cron</option></Select></label>
          {mode === "interval" ? <><label>Every <input aria-label="Schedule interval" type="number" min={60 / units[unit]} max={31536000 / units[unit]} step="any" required value={interval} onChange={event => setInterval(event.target.value)} /></label><label>Unit<Select aria-label="Schedule interval unit" value={unit} onChange={event => { const nextUnit = event.target.value as Unit; setInterval(String(Number(interval) * units[unit] / units[nextUnit])); setUnit(nextUnit); }}>{Object.keys(units).map(value => <option key={value}>{value}</option>)}</Select></label></> : <><label>Cron <input aria-label="Schedule cron" required value={cron} onChange={event => setCron(event.target.value)} /></label><label>Timezone <input aria-label="Schedule timezone" required value={timezone} onChange={event => setTimezone(event.target.value)} /></label></>}
          </div>
          {loaded ? <p>{preview}</p> : null}
          <div className="script-fields">
          <label>Method <Select aria-label="Schedule method" value={method} onChange={event => setMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => <option key={value}>{value}</option>)}</Select></label>
          <label>Path <input aria-label="Schedule path" required value={path} onChange={event => setPath(event.target.value)} /></label>
          </div>
          <details><summary>Advanced request settings</summary>
          <label>Headers (JSON) <textarea aria-label="Schedule headers" value={headers} onChange={event => { setHeaders(event.target.value); setOriginalHeaders(null); }} /></label>
          {duplicates ? <p>Repeated headers are preserved until you edit this field.</p> : null}
          {method !== "GET" && method !== "HEAD" ? <label>Body <textarea aria-label="Schedule body" value={body} onChange={event => setBody(event.target.value)} /></label> : null}
          </details>
          <button disabled={!loaded || busy}>Save schedule</button>
        </fieldset>
      </form>
      <p>Runs the latest validated revision. Missed occurrences are skipped. Failed or interrupted runs require an explicit retry.</p>
    </details>}
    <section className="run-history" aria-label="Run history"><h2>Recent runs</h2>
      <button disabled={busy} onClick={() => void perform(loadRuns)}>Refresh runs</button>
      {runsLoaded && !runs.length ? <p>No runs recorded yet.</p> : null}
      <p>HTTP-handler outcomes; background tasks and streamed response completion are separate. Latest 100 of up to 1,000 retained runs.</p>
      <table><thead><tr><th>Started (UTC)</th><th>Trigger</th><th>Status</th><th>HTTP</th><th>Duration</th><th>Revision</th>{kind === "script" ? <th>Logs</th> : null}</tr></thead><tbody>{runs.map(run => <tr key={run.id}><td>{displayTime(run.started_at)}</td><td>{run.trigger}</td><td>{run.status}</td><td>{run.http_status ?? "—"}</td><td>{run.duration_ms === null ? "—" : `${run.duration_ms} ms`}</td><td title={run.revision}>{run.revision.slice(0, 12)}</td>{kind === "script" ? <td><button disabled={busy} onClick={() => void perform(async () => setLogs(JSON.stringify(await galleryTool(workspace, "script_logs", { name, run_id: run.id }), null, 2)))}>View logs</button></td> : null}</tr>)}</tbody></table>
      {logs ? <pre aria-label="Run logs">{logs}</pre> : null}
    </section>
  </>;
}
