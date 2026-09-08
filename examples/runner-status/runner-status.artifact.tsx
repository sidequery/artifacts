import { useState, useEffect, useRef, useCallback, useMatch, useLocation, useNavigate, Link, pluginCall } from "sidequery/artifacts";

// Inline transport types keep this artifact portable as a single file.
type Runner = { id: number; name: string; status: string; busy: boolean; labels: { name: string }[] };
type Run = { id: number; name: string; display_title: string; html_url: string; head_branch: string; head_sha: string; status: string; created_at: string; run_number: number; run_attempt: number };
type Step = { name: string; number: number; status: string; conclusion: string | null; started_at: string | null };
type Job = { id: number; name: string; status: string; conclusion: string | null; html_url: string; runner_id: number | null; runner_name: string | null; labels: string[]; started_at: string | null; created_at?: string; steps: Step[] };
type Item = Job & { repo: string; run: Run; eligibleRunnerIds: number[] };
type RepoData = { jobs: (Job & { repo: string; run: Run })[]; fetchedAt: string; activeRuns: number };
type Snapshot = { org: string; repos: string[]; runners: Runner[]; jobs: Item[]; sources: { repo: string; fetchedAt: string | null; activeRuns: number; stale: boolean }[]; runnerFetchedAt: string | null; checkedAt: string; errors: string[]; refreshSeconds: number };

// Original microapp styles; this artifact owns its isolated document.
const styles = `:root{color-scheme:dark;--bg:#0d1117;--raised:#161b22;--subtle:#010409;--border:#30363d;--muted:#9198a1;--text:#f0f6fc;--blue:#4493f8;--green:#3fb950;--yellow:#d29922;--red:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,select{font:inherit}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
button{cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
button,input,select{color:var(--text);background:#21262d;border:1px solid var(--border);border-radius:6px}
button{padding:5px 12px;font-weight:500}
button:hover{background:#30363d}
input,select{padding:6px 10px}
input{background:var(--bg);min-width:210px}
input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.icon{width:16px;height:16px;display:inline-block;vertical-align:-3px;fill:currentColor;flex-shrink:0}
.global{height:64px;display:flex;align-items:center;gap:18px;padding:0 24px;background:var(--subtle)}
.global .mark{width:32px;height:32px}
.crumb{font-weight:600;display:flex;align-items:center;gap:12px}
.slash{color:var(--muted);font-weight:400}
.local{font-size:12px;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:1px 8px;font-weight:400}
.global-right{margin-left:auto;display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px}
.tabbar{height:49px;background:var(--subtle);padding-left:24px;border-bottom:1px solid var(--border);display:flex;align-items:stretch;gap:24px}
.top-tab{display:flex;align-items:center;gap:8px;position:relative;color:var(--text)}
.top-tab:after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;background:#f78166}
.layout{display:grid;grid-template-columns:256px minmax(0,1fr);min-height:calc(100vh - 113px)}
aside{border-right:1px solid var(--border);padding:28px 16px}
.aside-title{font-weight:600;padding:0 12px 12px}
.nav{width:100%;border:0;background:transparent;text-align:left;padding:9px 12px;display:flex;align-items:center;gap:9px;border-radius:6px;margin:3px 0;font-weight:400}
.nav.active{background:#1f2937;font-weight:600}
.count{background:#30363db3;font-size:12px;border-radius:20px;padding:0 7px;margin-left:auto;font-weight:500}
.aside-label{padding:28px 12px 8px;color:var(--muted);font-size:12px;font-weight:600}
.repo-side{padding:7px 12px;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.repo-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#a371f7;margin-right:8px}
.aside-note{color:var(--muted);font-size:12px;margin:28px 12px 0;line-height:1.7}
.main{padding:28px 32px;max-width:1600px;width:100%;margin:0 auto}
.heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
h1{font-size:24px;font-weight:600;margin:0 0 3px}
.muted{color:var(--muted)}
.subtitle{font-size:13px}
.live-dot{display:inline-block;width:7px;height:7px;background:var(--green);border-radius:50%;margin-right:6px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.stat{border:1px solid var(--border);border-radius:6px;padding:16px 18px}
.stat-label{font-size:12px;color:var(--muted);display:flex;gap:7px;align-items:center}
.stat-value{font-size:28px;font-weight:600;margin-top:4px;letter-spacing:-.5px}
.stat-detail{color:var(--muted);font-size:12px;margin-top:2px}
.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.toolbar input{flex:1}
.panel{border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:24px}
.panel-head{background:var(--raised);border-bottom:1px solid var(--border);padding:13px 16px;display:flex;align-items:center;gap:8px;font-weight:600}
.panel-head .muted{font-size:12px;font-weight:400;margin-left:auto}
.row{display:grid;grid-template-columns:minmax(155px,1fr) minmax(250px,2.25fr) 110px;gap:18px;padding:17px 16px;align-items:start;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}
.runner-name{font-weight:600;display:flex;align-items:center;gap:9px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;border:1px solid var(--border);border-radius:20px;padding:1px 8px;white-space:nowrap}
.pill.busy{color:var(--yellow);border-color:#9e6a034d;background:#bb80090d}
.pill.idle{color:var(--green);border-color:#23863660}
.pill.offline{color:var(--muted)}
.label{display:inline-block;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid var(--border);border-radius:12px;padding:0 6px;margin:5px 4px 0 0}
.title-link{font-weight:600;color:var(--text)}
.job-title{display:flex;gap:8px;align-items:baseline}
.job-meta{font-size:12px;color:var(--muted);margin-top:4px;overflow-wrap:anywhere}
.job-meta a{color:var(--muted)}
.job-meta a:hover{color:var(--blue)}
.step-line{color:var(--muted);font-size:12px;margin-top:7px;display:flex;gap:7px;align-items:center}
.elapsed{color:var(--muted);text-align:right;font-size:12px;white-space:nowrap}
.elapsed strong{display:block;color:var(--text);font-weight:500;font-variant-numeric:tabular-nums}
.yellow{color:var(--yellow)}
.green{color:var(--green)}
.red{color:var(--red)}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid #9e6a0340;border-top-color:var(--yellow);border-right-color:var(--yellow);border-radius:50%;animation:spin 1.2s linear infinite;flex-shrink:0}
.queued-dot{display:inline-block;width:13px;height:13px;border:2px solid var(--muted);border-radius:50%;flex-shrink:0}
.job-row{grid-template-columns:20px minmax(200px,1fr) 145px;gap:12px}
.job-row>.spinner,.job-row>.queued-dot{margin-top:5px}
.queue-context{font-size:12px;color:var(--muted);margin-top:7px}
.empty{text-align:center;padding:46px 16px;color:var(--muted)}
.empty strong{display:block;color:var(--text);font-size:16px;margin-bottom:6px}
.notice{border:1px solid #9e6a0380;background:#bb800915;padding:12px 16px;border-radius:6px;margin-bottom:20px;color:#e3b341;font-size:13px}
.notice a{color:inherit}
.footer{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:12px;padding:8px 0 20px}
.footer a{color:var(--muted)}
details{margin-top:6px}
summary{cursor:pointer;font-size:12px;color:var(--muted);width:fit-content}
.steps{padding:6px 0 0;margin:0;list-style:none}
.steps li{display:flex;gap:7px;align-items:center;font-size:12px;color:var(--muted);padding:3px 0}
.steps li .icon{width:12px;height:12px}
.loading{padding:70px 20px;text-align:center;color:var(--muted)}
.error-text{max-width:700px;overflow-wrap:anywhere}
.hide{display:none!important}
@keyframes spin{to{transform:rotate(360deg)}
}
@media(prefers-reduced-motion:reduce){.spinner{animation:none}
}
@media(min-width:1450px){.main{padding:32px 48px}
}
@media(max-width:1000px){.layout{grid-template-columns:210px minmax(0,1fr)}
.main{padding:24px}
.row{grid-template-columns:minmax(125px,1fr) minmax(190px,2fr) 85px;gap:10px}
.job-row{grid-template-columns:18px minmax(180px,1fr) 105px}
.stats{gap:8px}
.stat{padding:12px}
.global-right span{display:none}
}
@media(max-width:740px){.layout{display:block}
aside{border-right:0;border-bottom:1px solid var(--border);padding:10px 16px;display:flex;gap:8px}
.aside-title,.aside-label,.repo-side,.aside-note{display:none}
.nav{width:auto;flex:1;justify-content:center;padding:8px}
.nav .icon{display:none}
.main{padding:20px 16px}
.global{padding:0 16px;gap:12px}
.global-right{display:none}
.heading{align-items:flex-start}
h1{font-size:22px}
.stats{grid-template-columns:repeat(2,1fr)}
.toolbar{flex-wrap:wrap}
.toolbar input{width:100%;min-width:0}
.row{grid-template-columns:1fr 85px}
.row>div:nth-child(2){grid-row:2;grid-column:1/-1}
.row>.elapsed{grid-column:2;grid-row:1}
.job-row{grid-template-columns:18px 1fr 85px}
.job-row>div:nth-child(2){grid-row:1;grid-column:2}
.job-row>.elapsed{grid-column:3}
.panel-head .muted{display:none}
.footer{display:block}
.global .local{display:none}
}

#root{padding:0!important}

.runner-name a{color:inherit;text-decoration:none}

`;

function age(value: string | null, now: number): string {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function runnerState(runner: Runner) { return runner.status !== "online" ? "offline" : runner.busy ? "busy" : "idle"; }
function jobKey(job: Item) { return `${job.repo}:${job.id}`; }
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><strong>{title}</strong>{detail}</div>;
}
function Icon({ name, className = "" }: { name: "server" | "check" | "clock"; className?: string }) {
  const paths = {"server": "M2 1h12a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Zm.5 1.5v3h11v-3h-11ZM2 9h12a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm.5 1.5v3h11v-3h-11ZM4 3h1.5v2H4V3Zm0 8h1.5v2H4v-2Z", "check": "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z", "clock": "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0ZM1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0ZM8 3a.75.75 0 0 1 .75.75v3.5H11a.75.75 0 0 1 0 1.5H8A.75.75 0 0 1 7.25 8V3.75A.75.75 0 0 1 8 3Z"};
  return <svg className={`icon ${className}`} viewBox="0 0 16 16" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function JobBody({ job, now, opened, toggle }: { job: Item; now: number; opened: Set<string>; toggle: (key: string, open: boolean) => void }) {
  const step = job.steps.find(step => step.status === "in_progress");
  return <>
    <div className="job-title"><a className="title-link" href={safeUrl(job.html_url)} target="_blank" rel="noreferrer">{job.name}</a></div>
    <div className="job-meta"><a href={safeUrl(`https://github.com/${job.repo}`)} target="_blank" rel="noreferrer">{job.repo}</a> · <a href={safeUrl(job.run.html_url)} target="_blank" rel="noreferrer">{job.run.display_title || job.run.name} #{job.run.run_number}</a></div>
    <div className="job-meta">{job.run.head_branch} · {job.run.head_sha.slice(0, 7)}</div>
    {step && <div className="step-line"><span className="spinner" aria-hidden="true" />{step.name} · {age(step.started_at, now)}</div>}
    {!!job.steps.length && <details open={opened.has(jobKey(job))} onToggle={event => toggle(jobKey(job), event.currentTarget.open)}>
      <summary>{job.steps.filter(step => step.status === "completed").length} of {job.steps.length} steps complete</summary>
      <ol className="steps">{job.steps.map(step => <li key={step.number}>
        {step.status === "in_progress" ? <span className="spinner" aria-hidden="true" /> : <Icon name={step.conclusion === "success" ? "check" : "clock"} className={step.conclusion === "success" ? "green" : step.conclusion === "failure" ? "red" : ""} />}
        <span>{step.name}</span>
      </li>)}</ol>
    </details>}
  </>;
}
function queueHint(job: Item, runners: Runner[]) {
  if (job.status === "waiting") return "Waiting on GitHub approval or a workflow condition";
  if (!job.labels.length) return "Runner labels not yet published by GitHub";
  const matched = runners.filter(runner => job.eligibleRunnerIds.includes(runner.id));
  if (!matched.length) return "No label match in this displayed pool";
  const idle = matched.filter(runner => runnerState(runner) === "idle").length;
  return `${matched.length} label-matching runners · ${idle ? `${idle} idle` : "none idle"}`;
}

export default function RunnerStatus() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [search, setSearch] = useState("");
  const [repo, setRepo] = useState("");
  const [status, setStatus] = useState("");
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();
  const runnerMatch = useMatch("/runners/:id");
  const view = location.pathname === "/running" ? "running" : location.pathname === "/queued" ? "queued" : "runners";
  const knownRoute = ["/", "/runners", "/running", "/queued"].includes(location.pathname) || !!runnerMatch;
  const load = useCallback(async () => {
    if (!mounted.current || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const result = await pluginCall<Snapshot>("github-runners", "getStatus", {}, { signal: controller.signal });
      if (!controller.signal.aborted && mounted.current) { setData(result); setError(null); }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : "Status request failed");
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const poll = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const visible = () => { if (!document.hidden) { setNow(Date.now()); void load(); } };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
      clearInterval(poll); clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);
  const toggle = (key: string, open: boolean) => setOpened(previous => {
    if (previous.has(key) === open) return previous;
    const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next;
  });
  const running = data?.jobs.filter(job => job.status === "in_progress") || [];
  const queued = data?.jobs.filter(job => job.status !== "in_progress" && job.status !== "completed") || [];
  const runners = data?.runners || [];
  const term = search.toLowerCase();
  const filtered = (job: Item) => (!repo || job.repo === repo) && (!term || [job.name, job.repo, job.runner_name, job.run.display_title, job.run.head_branch, ...job.labels].join(" ").toLowerCase().includes(term));
  const selected = runnerMatch ? runners.find(runner => String(runner.id) === runnerMatch.params.id) : undefined;
  const shownRunners = runners.filter(runner => (!runnerMatch || runner === selected) && (!status || runnerState(runner) === status) && (!repo || running.some(job => job.runner_id === runner.id && job.repo === repo)) && (!term || [runner.name, ...runner.labels.map(label => label.name), ...running.filter(job => job.runner_id === runner.id).flatMap(job => [job.name, job.repo, job.run.display_title, job.run.head_branch])].join(" ").toLowerCase().includes(term))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const shownQueued = queued.filter(filtered).filter(job => !runnerMatch || !!selected && job.eligibleRunnerIds.includes(selected.id)).sort((a, b) => Date.parse(a.run.created_at) - Date.parse(b.run.created_at));
  const shownRunning = running.filter(filtered).sort((a, b) => Date.parse(a.started_at || a.run.created_at) - Date.parse(b.started_at || b.run.created_at));
  const visibleJobs = view === "runners" ? [...running.filter(job => shownRunners.some(runner => runner.id === job.runner_id)), ...shownQueued] : view === "running" ? shownRunning : shownQueued;
  const detailKeys = [...new Set(visibleJobs.filter(job => job.steps.length).map(jobKey))];
  const allOpen = detailKeys.length > 0 && detailKeys.every(key => opened.has(key));
  const occupied = runners.filter(runner => runner.busy);
  const unknown = occupied.filter(runner => !running.some(job => job.runner_id === runner.id));
  const online = runners.filter(runner => runner.status === "online");
  const longest = [...running].filter(job => job.started_at).sort((a, b) => Date.parse(a.started_at!) - Date.parse(b.started_at!))[0];
  const stale = data?.sources.filter(source => source.stale || !source.fetchedAt) || [];
  const overdue = !!data && now - Date.parse(data.checkedAt) > Math.max(data.refreshSeconds * 3, 120) * 1000;
  const partial = !!data && (!!data.errors.length || !!stale.length || !data.runnerFetchedAt || overdue);
  const heading = !knownRoute ? "Page not found" : runnerMatch ? selected?.name || "Runner not found" : { runners: "Self-hosted runners", running: "Running jobs", queued: "Queued jobs" }[view];
  const jobRows = (jobs: Item[], isQueued: boolean) => jobs.map(job => <div className="row job-row" key={jobKey(job)}>
    <span className={isQueued ? "queued-dot" : "spinner"} aria-hidden="true" />
    <div><JobBody job={job} now={now} opened={opened} toggle={toggle} />
      {isQueued ? <><div className="queue-context">{queueHint(job, runners)}</div><div>{job.labels.map(label => <span className="label" key={label}>{label}</span>)}</div></> : <div className="job-meta"><Icon name="server" /> {job.runner_id && runners.some(runner => runner.id === job.runner_id) ? <Link to={`/runners/${job.runner_id}`} style={{color:"inherit",textDecoration:"none"}}>{job.runner_name || `Runner ${job.runner_id}`}</Link> : job.runner_name || "Assignment pending"}</div>}
    </div>
    <div className="elapsed"><strong>{age(isQueued ? job.run.created_at : job.started_at, now)}</strong>{isQueued ? "since run created" : "running"}{isQueued && <div>{job.status.replaceAll("_", " ")}</div>}</div>
  </div>);
  const jobsPanel = (jobs: Item[], isQueued: boolean) => <section className="panel"><div className="panel-head"><span className={isQueued ? "queued-dot" : "spinner"} aria-hidden="true" />{isQueued ? runnerMatch ? "Label-matching queued jobs" : "Queued jobs" : "Running jobs"} <span className="count" style={{ marginLeft: 0 }}>{jobs.length}</span><span className="muted">{isQueued ? view === "runners" ? "Oldest workflow first" : "Workflow age shown; queue position is not exposed" : "Longest running first"}</span></div>{jobs.length ? jobRows(jobs, isQueued) : <Empty title={view === "runners" && isQueued ? "No jobs waiting" : "No matching jobs"} detail={view === "runners" && isQueued ? "The monitored repositories have no matching queued self-hosted jobs." : "Try another repository or clear the search."} />}</section>;
  return <div className="runner-status"><style>{styles}</style>
    <header className="global"><svg className="icon mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.128-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.445 0-1.196.426-2.186 1.128-2.956-.11-.275-.495-1.402.11-2.915 0 0 .921-.289 3.025 1.128A10.19 10.19 0 0 1 12 6.295c.936 0 1.871.124 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.22 2.64.11 2.915.702.77 1.128 1.746 1.128 2.956 0 4.235-2.571 5.17-5.019 5.445.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"/></svg><div className="crumb"><span>{data?.org || "Organization"}</span><span className="slash">/</span>runner-status <span className="local">Private</span></div><div className="global-right"><span>Self-hosted infrastructure</span><span className="pill">Read only</span></div></header>
    <div className="tabbar"><div className="top-tab"><svg className="icon" viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0ZM1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0Zm4.75-3a.75.75 0 0 1 .75 0l4 2.25a.75.75 0 0 1 0 1.3L7 10.8a.75.75 0 0 1-1.12-.65v-4.5A.75.75 0 0 1 6.25 5Z"/></svg>Actions</div></div>
    <div className="layout"><aside><div className="aside-title">Runner pool</div>{([['runners', '/runners', 'Runners', runners.length], ['running', '/running', 'Running jobs', running.length], ['queued', '/queued', 'Queued jobs', queued.length]] as const).map(([name, to, title, count]) => <button key={name} type="button" onClick={() => navigate(to)} className={`nav ${view === name ? "active" : ""}`} aria-current={view === name ? "page" : undefined}>{title} <span className="count">{data ? count : "—"}</span></button>)}
      <div className="aside-label">MONITORED REPOSITORIES</div><div id="repo-list">{data?.repos.map(repo => <div className="repo-side" key={repo}><span className="repo-dot" />{repo}</div>)}</div><div className="aside-note">One shared runner pool.<br />Assignments and job steps come directly from GitHub Actions.</div>
    </aside><main className="main"><div className="heading"><div>{runnerMatch && <Link to="/runners">← All runners</Link>}<h1>{data || !knownRoute ? heading : "Self-hosted runners"}</h1><div className="subtitle muted">{view === "queued" ? "Not-started jobs, oldest workflow first · not a guaranteed execution order" : runnerMatch ? "Current assignment and queued label matches" : view === "running" ? "Current workflow jobs and the steps they are executing" : "Live assignments across your shared runner pool"}</div></div><div style={{ display: "flex", gap: 8, flexShrink: 0 }}><button type="button" disabled={!detailKeys.length} onClick={() => setOpened(previous => { const next = new Set(previous); detailKeys.forEach(key => allOpen ? next.delete(key) : next.add(key)); return next; })}>{allOpen ? "Collapse all" : "Expand all"}</button><button type="button" disabled={loading} onClick={() => void load()}>↻ &nbsp; Refresh</button></div></div>
      {error && <div className="notice" role="alert">Unable to refresh: {error}. {data ? "Showing the last received snapshot." : "Check the github-runners plugin configuration and server status, then retry."}</div>}
      {data && (partial || unknown.length > 0) && <div className="notice" role="status">{partial && <><strong>Partial or stale data.</strong> {data.errors.join(" ")}{overdue && <div>The collector has not updated recently. Showing the last received snapshot.</div>}{data.runnerFetchedAt && data.errors.some(message => message.startsWith("Runner status:")) && <div>Runner status is stale · last fetched {age(data.runnerFetchedAt, now)} ago.</div>}{stale.map(source => <div key={source.repo}>{source.repo}: {source.fetchedAt ? `stale · last fetched ${age(source.fetchedAt, now)} ago` : "no successful fetch yet"}</div>)}{!data.runnerFetchedAt && <div>Runner status has not been fetched successfully.</div>}</>}{unknown.length > 0 && <div>{unknown.length} busy runner{unknown.length === 1 ? " has" : "s have"} no matching job in the monitored repositories. GitHub may be assigning or finishing a job, or another repository is using the pool.</div>}</div>}
      {data && <><section className="stats" aria-label="Pool summary">{[
        ["Online runners", `${online.length} / ${runners.length}`, `${runners.length - online.length} offline`],
        ["Busy runners", occupied.length, `${online.filter(runner => !runner.busy).length} runners available`],
        ["Queued jobs", queued.length, "Not yet running"],
        ["Longest running job", longest ? age(longest.started_at, now) : "—", longest?.repo || "No active jobs"],
      ].map(([label, value, detail]) => <div className="stat" key={label}><div className="stat-label">{label}</div><div className={`stat-value${label === "Busy runners" ? " yellow" : ""}`}>{value}</div><div className="stat-detail">{detail}</div></div>)}</section>
      <div className="toolbar"><input aria-label="Filter runners and jobs" placeholder="Filter runners and jobs…" type="search" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Repository" value={repo} onChange={event => setRepo(event.target.value)}><option value="">All repositories</option>{data.repos.map(repo => <option key={repo}>{repo}</option>)}</select>{view === "runners" && <select aria-label="Runner status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option><option value="busy">Busy</option><option value="idle">Idle</option><option value="offline">Offline</option></select>}</div>
      {!knownRoute ? <Empty title="Page not found" detail="Choose Runners, Running jobs, or Queued jobs from the navigation." /> : runnerMatch && !selected ? <Empty title="Runner not found" detail="This runner is not in the displayed pool. It may have been removed or excluded by the configured prefix." /> : view === "runners" ? <><section className="panel"><div className="panel-head"><Icon name="server" /> Runners <span className="count" style={{ marginLeft: 0 }}>{shownRunners.length}</span><span className="muted">Status &nbsp; / &nbsp; Current assignment</span></div>{shownRunners.length ? shownRunners.map(runner => {
        const state = runnerState(runner), jobs = running.filter(job => job.runner_id === runner.id);
        return <div className="row" key={runner.id}><div><div className="runner-name"><Icon name="server" /><Link to={`/runners/${runner.id}`} style={{color:"inherit",textDecoration:"none"}}>{runner.name}</Link></div><div style={{ marginTop: 7 }}><span className={`pill ${state}`}>{state === "busy" && <span className="spinner" aria-hidden="true" />}{state[0]!.toUpperCase() + state.slice(1)}</span></div><div>{runner.labels.map(label => <span className="label" key={label.name}>{label.name}</span>)}</div></div><div>{jobs.length ? jobs.map(job => <div key={jobKey(job)}><JobBody job={job} now={now} opened={opened} toggle={toggle} /></div>) : <span className="muted">{runner.busy ? "Assignment not visible in monitored repositories" : state === "offline" ? "Runner is not connected to GitHub" : "Ready to pick up a job"}</span>}</div><div className="elapsed">{jobs.length > 0 && <><strong>{age(jobs[0]!.started_at, now)}</strong>running</>}</div></div>;
      }) : <Empty title="No matching runners" detail="Try clearing a filter." />}</section>{jobsPanel(shownQueued, true)}</> : jobsPanel(view === "running" ? shownRunning : shownQueued, view === "queued")}</>}
      {!data && <div className="loading" role="status">{loading ? <><span className="spinner" aria-hidden="true" /> Loading runners and workflow jobs…</> : "Runner status is unavailable. Use Refresh to retry."}</div>}
      <footer className="footer"><span aria-live="polite">{!error && data && !partial && <span className="live-dot" />}{error ? "Disconnected · last successful update " : partial ? "Partial data · checked " : data ? "Updated " : "Fetching GitHub status"}{data && <>{age(data.checkedAt, now)} ago{!error && <> · refreshes every {data.refreshSeconds}s</>}</>}</span>{data && <a href={safeUrl(`https://github.com/organizations/${encodeURIComponent(data.org)}/settings/actions/runners`)} target="_blank" rel="noreferrer">Manage runners on GitHub ↗</a>}</footer>
    </main></div>
  </div>;
}
