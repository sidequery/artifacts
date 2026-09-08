import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { PLUGIN_ROOT } from "../src/paths";
import { VALID_ARTIFACT } from "../src/test/fixtures";

const SESSION = process.env.HERDR_SESSION ?? "artifact-e2e";
const HOME = process.env.HOME ?? join(tmpdir(), "artifacts-e2e-home");

function herdr(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("herdr", args, {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      HOME,
      HERDR_SESSION: SESSION,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function mustHerdr(args: string[]): string {
  const result = herdr(args);
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function waitForHerdr(timeoutMs = 25_000): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const listed = herdr(["session", "list", "--json"]);
    last = `session list status=${listed.status}\n${listed.stdout}\n${listed.stderr}`;
    if (listed.status === 0 && listed.stdout.includes(SESSION)) {
      const panes = herdr(["pane", "list"]);
      last += `\npane list status=${panes.status}\n${panes.stdout}\n${panes.stderr}`;
      if (panes.status === 0) {
        return;
      }
    }
    await Bun.sleep(200);
  }
  throw new Error(`herdr session ${SESSION} did not become ready\n${last}`);
}

function startPty(): ReturnType<typeof Bun.spawn> {
  mkdirSync(join(HOME, ".config/herdr"), { recursive: true });
  writeFileSync(
    join(HOME, ".config/herdr/config.toml"),
    `[experimental]
kitty_graphics = true

[terminal]
default_shell = "/bin/bash"
`,
  );
  return Bun.spawn(
    ["script", "-qefc", `herdr --session ${SESSION} server`, "/tmp/herdr-pty.log"],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "pipe",
      env: {
        ...process.env,
        HOME,
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
        HERDR_SESSION: SESSION,
      },
    },
  );
}

async function main(): Promise<void> {
  const pty = startPty();
  console.error("started herdr PTY server");
  try {
    await waitForHerdr();
    console.error("herdr session is ready");

    mustHerdr(["plugin", "link", PLUGIN_ROOT]);
    mustHerdr(["workspace", "create", "--cwd", PLUGIN_ROOT, "--label", "artifact-e2e", "--focus"]);

    const plugins = JSON.parse(mustHerdr(["plugin", "list", "--json"])) as {
      result?: { plugins?: Array<{ plugin_id?: string }> };
    };
    const pluginIds = (plugins.result?.plugins ?? []).map((plugin) => plugin.plugin_id ?? "");
    if (!pluginIds.includes("herdr.artifacts")) {
      throw new Error(`herdr.artifacts not linked: ${JSON.stringify(pluginIds)}`);
    }

    const artifactsDir = mkdtempSync(join(tmpdir(), "artifacts-e2e-"));
    writeFileSync(join(artifactsDir, "overview.artifact.tsx"), VALID_ARTIFACT);
    const historyDb = join(HOME, "artifact-history.sqlite");
    const artifactEnv = {
      ...process.env, HOME, HERDR_SESSION: SESSION,
      ARTIFACTS_DIR: artifactsDir,
      ARTIFACTS_HISTORY_DB: historyDb,
      HERDR_PLUGIN_STATE_DIR: join(HOME, "artifact-state"),
      SHELL: "/bin/bash", TERM: "xterm-256color",
    };

    const opened = spawnSync("bun", [join(PLUGIN_ROOT, "src/cli.ts"), "open", "overview", "--dir", artifactsDir, "--placement", "tab"], {
      encoding: "utf8",
      timeout: 30_000,
      env: artifactEnv,
    });
    if (opened.status !== 0) {
      throw new Error(`artifacts open failed\n${opened.stdout}\n${opened.stderr}`);
    }
    const payload = JSON.parse(opened.stdout) as {
      ok: boolean;
      url?: string;
      opened?: string;
      check?: string;
      herdr?: { stdout?: string };
    };
    if (!payload.ok) {
      throw new Error(`artifacts open returned failure: ${opened.stdout}`);
    }
    if (payload.check !== "Artifact TypeScript check: no errors") {
      throw new Error(payload.check ?? "missing typecheck");
    }
    if (payload.opened !== "artifact-pane") {
      throw new Error(`open did not create an Artifact-owned pane: ${opened.stdout}`);
    }

    const paneOpened = JSON.parse(payload.herdr?.stdout ?? "{}") as {
      result?: {
        plugin_pane?: {
          plugin_id?: string;
          pane?: { pane_id?: string; label?: string };
        };
      };
    };
    const pluginPane = paneOpened.result?.plugin_pane;
    const paneId = pluginPane?.pane?.pane_id;
    if (pluginPane?.plugin_id !== "herdr.artifacts" || pluginPane.pane?.label !== "Artifact" || !paneId) {
      throw new Error(`pane is not owned by herdr.artifacts: ${payload.herdr?.stdout}`);
    }

    const artifactUrl = await waitForArtifactUrl(paneId);
    const page = await fetch(artifactUrl);
    const html = await page.text();
    if (!page.ok || !html.includes("__artifacts") || !html.includes("bundle.js")) {
      throw new Error(`artifact page was not served: ${page.status} ${html.slice(0, 500)}`);
    }
    const scriptPath = html.match(/src="([^\"]+bundle\.js[^\"]*)"/)?.[1];
    if (!scriptPath || !scriptPath.startsWith("/v/")) throw new Error("page bundle was not pinned to a version");
    const js = await fetch(new URL(scriptPath, artifactUrl));
    const bundle = await js.text();
    if (!js.ok || !bundle.includes("Overview")) {
      throw new Error(`artifact bundle missing compiled UI: ${js.status} ${bundle.slice(0, 200)}`);
    }

    const paneList = mustHerdr(["pane", "list"]);
    if (!paneList.includes("Artifact")) {
      throw new Error(`Artifact pane missing after open\n${paneList}`);
    }

    mustHerdr(["pane", "close", paneId]);
    await waitForServerStop(artifactUrl);

    const archived = spawnSync("bun", [join(PLUGIN_ROOT, "src/cli.ts"), "history", "overview"], { encoding: "utf8", timeout: 10_000, env: artifactEnv });
    if (archived.status !== 0) throw new Error(`history failed after close: ${archived.stderr}`);
    const versions = JSON.parse(archived.stdout).versions as Array<{ version_id: string; serve_count: number }>;
    if (versions.length !== 1 || !versions[0]?.serve_count) throw new Error(`missing durable history: ${archived.stdout}`);
    unlinkSync(join(artifactsDir, "overview.artifact.tsx")); // Disposable E2E fixture.
    const reopened = spawnSync("bun", [join(PLUGIN_ROOT, "src/cli.ts"), "open", "--version", versions[0].version_id, "--placement", "tab"], { encoding: "utf8", timeout: 30_000, env: artifactEnv });
    if (reopened.status !== 0) throw new Error(`archive reopen failed: ${reopened.stdout}\n${reopened.stderr}`);
    const replayPane = JSON.parse(JSON.parse(reopened.stdout).herdr.stdout).result.plugin_pane.pane.pane_id as string;
    const replayUrl = await waitForArtifactUrl(replayPane);
    if (!replayUrl.includes(`/v/${versions[0].version_id}`)) throw new Error(`wrong replay URL: ${replayUrl}`);
    const replayPage = await fetch(replayUrl);
    const replayHtml = await replayPage.text();
    const replayScript = replayHtml.match(/src="([^\"]+bundle\.js[^\"]*)"/)?.[1];
    if (!replayPage.ok || !replayScript) throw new Error("archived page failed after original source deletion");
    const replayBundle = await fetch(new URL(replayScript, replayUrl));
    if (!replayBundle.ok || !(await replayBundle.text()).includes("Overview")) throw new Error("archived raw TSX did not rebuild");
    mustHerdr(["pane", "close", replayPane]);
    await waitForServerStop(replayUrl);

    console.log(
      JSON.stringify(
        {
          ok: true,
          url: artifactUrl,
          opened: payload.opened,
          pluginId: pluginPane.plugin_id,
          paneId,
          serverStopped: true,
          archivedVersion: versions[0].version_id,
          reopenedAfterDeletion: true,
          replayServerStopped: true,
          terminalBrowser: "terminal-browser --app-mode",
          plugins: pluginIds,
          panes: paneList.trim(),
        },
        null,
        2,
      ),
    );
  } finally {
    herdr(["session", "stop", SESSION]);
    pty.kill();
    await pty.exited.catch(() => undefined);
  }
}

async function waitForArtifactUrl(paneId: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const processInfo = herdr(["pane", "process-info", "--pane", paneId]);
    last = `${processInfo.stdout}\n${processInfo.stderr}`;
    const match = last.match(/http:\/\/127\.0\.0\.1:\d+\/(?:c\/overview|v\/[a-f0-9-]+)/);
    if (processInfo.status === 0 && match) {
      return match[0];
    }
    await Bun.sleep(200);
  }
  const paneList = herdr(["pane", "list"]);
  throw new Error(`Artifact Terminal Browser did not load its managed URL\n${last}\n\npanes:\n${paneList.stdout}\n${paneList.stderr}`);
}

async function waitForServerStop(artifactUrl: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(artifactUrl, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Artifact server remained alive after its pane closed: ${artifactUrl}`);
}

await main();
