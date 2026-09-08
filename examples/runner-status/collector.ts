import type { Item, Job, RepoData, Run, Runner, Snapshot } from "./types";

export const refreshSeconds = 45;
const activeStates = ["in_progress", "queued", "waiting", "pending", "requested"];
export type Config = { org: string; repos: string[]; runnerPrefix: string };
export type Cache = { runners: Runner[]; runnerFetchedAt: string | null; repos: Record<string, RepoData>; snapshot: Snapshot | null };
export type List = <T>(endpoint: string, field: string) => Promise<T[]>;
export const emptyCache = (): Cache => ({ runners: [], runnerFetchedAt: null, repos: {}, snapshot: null });

export function readConfig(env: { RUNNER_ORG: string; RUNNER_REPOS: string; RUNNER_NAME_PREFIX?: string }): Config {
  const repos = [...new Set(env.RUNNER_REPOS?.split(",").map(repo => repo.trim()).filter(Boolean))];
  if (!/^[a-zA-Z0-9-]+$/.test(env.RUNNER_ORG ?? "") || !repos.length || repos.length > 20
    || repos.some(repo => !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) || [".", ".."].includes(repo.split("/")[1]!))) throw new Error("Configure RUNNER_ORG and 1–20 RUNNER_REPOS");
  return { org: env.RUNNER_ORG, repos, runnerPrefix: env.RUNNER_NAME_PREFIX ?? "" };
}
export async function mapLimit<T, U>(values: T[], limit: number, fn: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []; let index = 0, failed = false;
  // Drain siblings before rejecting so the caller keeps its abort deadline alive
  // until every in-flight request has settled.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, values.length) }, async () => {
    try {
      while (!failed && index < values.length) { const i = index++; results[i] = await fn(values[i]!); }
    } catch (error) { failed = true; throw error; }
  }));
  const failure = workers.find(worker => worker.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

/** One limiter for the entire refresh, including pagination across repositories. */
export function githubList(token: string, signal: AbortSignal, request: typeof fetch = fetch): List {
  let active = 0;
  const waiting: (() => void)[] = [];
  async function page(url: URL): Promise<{ value: Record<string, unknown>; next: string | null }> {
    if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try {
      signal.throwIfAborted();
      const response = await request(url, { signal, redirect: "manual", headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "canvas-runner-status",
        "x-github-api-version": "2022-11-28",
      } });
      if (!response.ok) { await response.body?.cancel(); throw new Error("GitHub request failed"); }
      const value = await response.json() as Record<string, unknown>;
      const next = response.headers.get("link")?.split(",").map(part => part.trim()).find(part => /;\s*rel="next"/.test(part))?.match(/^<([^>]+)>/)?.[1] ?? null;
      return { value, next };
    } finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  return async <T>(endpoint: string, field: string): Promise<T[]> => {
    const initial = new URL(`https://api.github.com/${endpoint}`);
    let url: URL | null = initial;
    const values: T[] = [], seen = new Set<string>();
    while (url) {
      // Never forward the credential to a pagination URL outside this exact endpoint.
      if (url.origin !== initial.origin || url.pathname !== initial.pathname || url.username || url.password || seen.has(url.href) || seen.size >= 100) throw new Error("Invalid GitHub pagination");
      seen.add(url.href);
      const { value, next } = await page(url);
      if (!Array.isArray(value[field])) throw new Error("Invalid GitHub response");
      values.push(...value[field] as T[]);
      url = next ? new URL(next, initial) : null;
    }
    return values;
  };
}
export function eligible(job: Job, runners: Runner[]): number[] {
  const labels = (job.labels || []).map(label => label.toLowerCase());
  return labels.length ? runners.filter(runner => labels.every(label => runner.labels.some(candidate => candidate.name.toLowerCase() === label))).map(runner => runner.id) : [];
}
export function relevant(job: Job, runners: Runner[]): boolean {
  return job.labels?.some(label => label.toLowerCase() === "self-hosted") || runners.some(runner => runner.id === job.runner_id);
}
export async function readRepo(repo: string, list: List, now: () => string): Promise<RepoData> {
  const batches = await mapLimit(activeStates, 2, status => list<Run>(`repos/${repo}/actions/runs?per_page=100&status=${status}`, "workflow_runs"));
  const runs = [...new Map(batches.flat().map(run => [run.id, run])).values()];
  const jobs = (await mapLimit(runs, 3, async raw => {
    // Keep only fields the UI needs; GitHub run records contain large nested repositories.
    const run: Run = { id: raw.id, name: raw.name, display_title: raw.display_title, html_url: raw.html_url, head_branch: raw.head_branch, head_sha: raw.head_sha, status: raw.status, created_at: raw.created_at, run_number: raw.run_number, run_attempt: raw.run_attempt };
    return (await list<Job>(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, "jobs"))
      .filter(job => job.status !== "completed").map(job => ({
        id: job.id, name: job.name, status: job.status, conclusion: job.conclusion ?? null, html_url: job.html_url,
        runner_id: job.runner_id ?? null, runner_name: job.runner_name ?? null, labels: job.labels ?? [], started_at: job.started_at ?? null,
        steps: (job.steps ?? []).map(step => ({ name: step.name, number: step.number, status: step.status, conclusion: step.conclusion ?? null, started_at: step.started_at ?? null })), repo, run,
      }));
  })).flat();
  return { jobs, activeRuns: runs.length, fetchedAt: now() };
}
export async function refresh(config: Config, previous: Cache, list: List, now = () => new Date().toISOString()): Promise<Cache> {
  const cache: Cache = { ...previous, repos: { ...previous.repos } };
  const errors: string[] = [], stale = new Set<string>();
  await Promise.all([
    (async () => {
      try {
        cache.runners = (await list<Runner>(`orgs/${config.org}/actions/runners?per_page=100`, "runners"))
          .filter(runner => runner.name.startsWith(config.runnerPrefix))
          .map(runner => ({ id: runner.id, name: runner.name, status: runner.status, busy: runner.busy, labels: runner.labels.map(label => ({ name: label.name })) }));
        cache.runnerFetchedAt = now();
      } catch { errors.push("Runner status could not refresh; showing last-known runner data if available."); }
    })(),
    mapLimit(config.repos, 2, async repo => {
      try { cache.repos[repo] = await readRepo(repo, list, now); }
      catch { stale.add(repo); errors.push(`${repo} could not refresh; showing last-known jobs if available.`); }
    }),
  ]);
  const jobs: Item[] = [...new Map(config.repos.flatMap(repo => cache.repos[repo]?.jobs ?? []).map(job => [`${job.repo}:${job.id}`, job])).values()]
    .filter(job => relevant(job, cache.runners)).map(job => ({ ...job, eligibleRunnerIds: eligible(job, cache.runners) }));
  cache.snapshot = { org: config.org, repos: config.repos, runners: cache.runners, jobs,
    sources: config.repos.map(repo => ({ repo, fetchedAt: cache.repos[repo]?.fetchedAt ?? null, activeRuns: cache.repos[repo]?.activeRuns ?? 0, stale: stale.has(repo) })),
    runnerFetchedAt: cache.runnerFetchedAt, checkedAt: now(), errors, refreshSeconds };
  return cache;
}

/** Leave room for the MCP result envelope within the bridge's 256 KiB limit. */
export function boundedSnapshot(snapshot: Snapshot): Snapshot {
  const result = { ...snapshot, runners: [...snapshot.runners], jobs: [...snapshot.jobs], errors: [...snapshot.errors] };
  const size = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (size() > 230 * 1024) {
    result.errors.push("Snapshot exceeds the display limit; some jobs or runners are omitted. Narrow RUNNER_REPOS or RUNNER_NAME_PREFIX.");
    // Binary search the retained prefix instead of repeatedly encoding an entire
    // large snapshot once per removed row.
    for (const field of ["jobs", "runners"] as const) {
      if (size() <= 230 * 1024) break;
      const original = result[field];
      let low = 0, high = original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        Object.assign(result, { [field]: original.slice(0, middle) });
        if (size() <= 230 * 1024) low = middle;
        else high = middle - 1;
      }
      Object.assign(result, { [field]: original.slice(0, low) });
    }
  }
  return result;
}
