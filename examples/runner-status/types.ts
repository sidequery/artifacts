export type Runner = { id: number; name: string; status: string; busy: boolean; labels: { name: string }[] };
export type Run = { id: number; name: string; display_title: string; html_url: string; head_branch: string; head_sha: string; status: string; created_at: string; run_number: number; run_attempt: number };
export type Step = { name: string; number: number; status: string; conclusion: string | null; started_at: string | null };
export type Job = { id: number; name: string; status: string; conclusion: string | null; html_url: string; runner_id: number | null; runner_name: string | null; labels: string[]; started_at: string | null; created_at?: string; steps: Step[] };
export type Item = Job & { repo: string; run: Run; eligibleRunnerIds: number[] };
export type RepoData = { jobs: (Job & { repo: string; run: Run })[]; fetchedAt: string; activeRuns: number };
export type Snapshot = { org: string; repos: string[]; runners: Runner[]; jobs: Item[]; sources: { repo: string; fetchedAt: string | null; activeRuns: number; stale: boolean }[]; runnerFetchedAt: string | null; checkedAt: string; errors: string[]; refreshSeconds: number };
