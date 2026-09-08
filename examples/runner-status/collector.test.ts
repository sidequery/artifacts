import { expect, test } from "bun:test";
import { boundedSnapshot, emptyCache, eligible, githubList, readConfig, readRepo, refresh, relevant, type List } from "./collector";
import type { Job, Run, Runner } from "./types";

const config = { org: "example", repos: ["example/app"], runnerPrefix: "" };
const runner: Runner = { id: 1, name: "runner-1", status: "online", busy: true, labels: [{ name: "self-hosted" }, { name: "macOS" }] };
const run: Run = { id: 7, status: "in_progress", name: "CI", display_title: "Fix", html_url: "https://github.com/example/app/actions/runs/7", head_branch: "main", head_sha: "abc", created_at: "2026-09-07T00:00:00Z", run_number: 1, run_attempt: 1 };
const job: Job = { id: 10, name: "Check", status: "queued", labels: ["self-hosted", "macos"], steps: [], conclusion: null, started_at: null, runner_id: null, runner_name: null, html_url: "https://github.com/example/app/actions/runs/7/job/10" };
const fixture: List = async <T>(endpoint: string) => (endpoint.includes("/actions/runners") ? [runner] : endpoint.includes("/jobs?") ? [job] : [run]) as T[];

test("validates configured scope and preserves unknown labels / hosted-job exclusion", () => {
  expect(readConfig({ RUNNER_ORG: "example", RUNNER_REPOS: "example/app, example/app" }).repos).toEqual(["example/app"]);
  expect(() => readConfig({ RUNNER_ORG: "example", RUNNER_REPOS: "../secret" })).toThrow();
  expect(eligible(job, [runner])).toEqual([1]);
  expect(eligible({ ...job, labels: [] }, [runner])).toEqual([]);
  expect(eligible({ ...job, labels: ["linux"] }, [runner])).toEqual([]);
  expect(relevant({ ...job, labels: ["ubuntu-latest"] }, [runner])).toBe(false);
  expect(relevant({ ...job, labels: [], runner_id: 1 }, [runner])).toBe(true);
});

test("deduplicates runs across all five active states and excludes completed jobs", async () => {
  let jobsCalls = 0; const states: string[] = [];
  const list: List = async <T>(endpoint: string) => {
    if (endpoint.includes("/jobs?")) { jobsCalls++; return [job, { ...job, id: 11, status: "completed" }] as T[]; }
    states.push(new URL(`https://api.github.com/${endpoint}`).searchParams.get("status")!);
    return [run] as T[];
  };
  const data = await readRepo("example/app", list, () => "now");
  expect(states.sort()).toEqual(["in_progress", "pending", "queued", "requested", "waiting"]);
  expect(jobsCalls).toBe(1);
  expect(data.jobs.map(job => job.id)).toEqual([10]);
  expect(data.jobs[0]!.repo).toBe("example/app");
});

test("preserves per-source data and timestamps on failure, then clears errors on recovery", async () => {
  const first = await refresh(config, emptyCache(), fixture, () => "2026-09-07T00:00:00Z");
  const failed = await refresh(config, first, async () => { throw new Error("secret provider error"); }, () => "2026-09-07T00:01:00Z");
  expect(failed.snapshot!.jobs).toEqual(first.snapshot!.jobs);
  expect(failed.snapshot!.runners).toEqual([runner]);
  expect(failed.snapshot!.runnerFetchedAt).toBe(first.snapshot!.runnerFetchedAt);
  expect(failed.snapshot!.sources[0]).toMatchObject({ stale: true, fetchedAt: "2026-09-07T00:00:00Z" });
  expect(failed.snapshot!.errors).toHaveLength(2);
  expect(JSON.stringify(failed)).not.toContain("secret provider error");
  const recovered = await refresh(config, failed, fixture, () => "2026-09-07T00:02:00Z");
  expect(recovered.snapshot!.errors).toEqual([]);
  expect(recovered.snapshot!.sources[0]).toMatchObject({ stale: false, fetchedAt: "2026-09-07T00:02:00Z" });
  expect(first.snapshot!.errors).toEqual([]);
});

test("follows pagination with server credentials and bounds concurrency across callers", async () => {
  let active = 0, peak = 0, calls = 0;
  const list = githubList("test-token", new AbortController().signal, (async (input, init) => {
    active++; peak = Math.max(peak, active); calls++;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    expect(init?.redirect).toBe("manual");
    await Bun.sleep(2); active--;
    const url = new URL(String(input));
    return Response.json({ jobs: [url.searchParams.has("page") ? 2 : 1] }, { headers: url.searchParams.has("page") ? {} : { link: `<${url.href}&page=2>; rel="next"` } });
  }) as typeof fetch);
  const values = await Promise.all(Array.from({ length: 9 }, () => list("repos/example/app/actions/jobs?per_page=100", "jobs")));
  expect(values).toEqual(Array.from({ length: 9 }, () => [1, 2]));
  expect(peak).toBe(4); expect(calls).toBe(18);
});

test("rejects foreign, repeated or cross-endpoint pagination without forwarding token", async () => {
  for (const next of ["https://evil.example/steal", "https://api.github.com/user", "https://api.github.com/repos/example/app/actions/jobs"]) {
    let calls = 0;
    const list = githubList("secret", new AbortController().signal, (async () => {
      calls++; return Response.json({ jobs: [] }, { headers: { link: `<${next}>; rel="next"` } });
    }) as typeof fetch);
    await expect(list("repos/example/app/actions/jobs", "jobs")).rejects.toThrow("Invalid GitHub pagination");
    expect(calls).toBe(1);
  }
});

test("queued callers respect an aborted refresh without starting more requests", async () => {
  const controller = new AbortController(); let calls = 0;
  const list = githubList("test-token", controller.signal, (async () => {
    calls++; await Bun.sleep(2); controller.abort(); throw new Error("aborted");
  }) as typeof fetch);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => list("repos/example/app/actions/jobs", "jobs")));
  expect(calls).toBe(4);
  expect(results.every(result => result.status === "rejected")).toBe(true);
});

test("oversized snapshots fit the bridge and visibly report omissions without mutating cache", async () => {
  const cache = await refresh(config, emptyCache(), fixture);
  const huge = { ...cache.snapshot!, jobs: Array.from({ length: 1000 }, (_, id) => ({ ...cache.snapshot!.jobs[0]!, id, name: "x".repeat(1000) })) };
  const bounded = boundedSnapshot(huge);
  expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(230 * 1024);
  expect(bounded.errors.join(" ")).toContain("omitted");
  expect(huge.jobs).toHaveLength(1000);
});

test("a failed repository drains sibling I/O before refresh returns", async () => {
  const controller = new AbortController();
  let outstanding = 0, finished = false;
  const list: List = async <T>(endpoint: string) => {
    if (endpoint.includes("/actions/runners")) return [] as T[];
    if (endpoint.includes("status=in_progress")) throw new Error("fast failure");
    outstanding++;
    try {
      await new Promise<void>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
      return [] as T[];
    } finally { outstanding--; }
  };
  const pending = refresh(config, emptyCache(), list).then(result => { finished = true; return result; });
  await Bun.sleep(5);
  expect(outstanding).toBe(1);
  expect(finished).toBe(false);
  controller.abort();
  expect((await pending).snapshot!.errors).toHaveLength(1);
  expect(outstanding).toBe(0);
});
