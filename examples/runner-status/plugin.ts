import type { CanvasPlugin } from "../../src/plugins/config";
import type { PluginUser } from "../../src/plugins/types";
import type { Snapshot } from "./types";

export function runnerStatusPlugin(options: { allowedUsers: readonly PluginUser[]; allowLoopback?: boolean }): CanvasPlugin {
  return {
    name: "github-runners",
    description: "Shared self-hosted GitHub runner pool: assignments, steps, queued jobs and source freshness.",
    secrets: ["RUNNER_STATUS_URL", "RUNNER_STATUS_TOKEN"],
    operations: {
      getStatus: {
        description: "Read the shared runner snapshot. Label matches are not scheduling guarantees; queued durations are since workflow creation. Inspect errors and source timestamps for partial/stale data.",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        authorize: user => options.allowedUsers.some(allowed => allowed.subject === user.subject && allowed.authority === user.authority),
        async handler(_input: Record<string, never>, { secrets, signal }): Promise<Snapshot> {
          const url = new URL(secrets.RUNNER_STATUS_URL!);
          const local = options.allowLoopback === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
          if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/api/status") throw new Error("Invalid collector URL");
          const response = await fetch(url, { signal, redirect: "manual", headers: { authorization: `Bearer ${secrets.RUNNER_STATUS_TOKEN}` } });
          if (!response.ok) { await response.body?.cancel(); throw new Error("Runner collector unavailable"); }
          return response.json() as Promise<Snapshot>;
        },
      },
    },
  };
}
