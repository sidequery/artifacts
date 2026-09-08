import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type HerdrClient = {
  bin: string;
  run(args: string[]): CommandResult;
};

export function createHerdrClient(env: NodeJS.ProcessEnv = process.env): HerdrClient {
  const bin = env.HERDR_BIN_PATH ?? "herdr";
  return {
    bin,
    run(args) {
      const result = spawnSync(bin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

export type PanePlacement = "split" | "tab" | "zoomed" | "overlay";

export function artifactPaneOpenArgs(
  artifactPath: string,
  artifactsDir: string,
  opts: {
    placement?: PanePlacement;
    direction?: "right" | "down";
    focus?: boolean;
    workspaceId?: string;
    targetPaneId?: string;
    historyPath?: string;
    versionId?: string;
    eventId?: string;
  } = {},
): string[] {
  const placement = opts.placement ?? "split";
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "herdr.artifacts",
    "--entrypoint",
    "artifacts",
    "--placement",
    placement,
    "--env",
    `ARTIFACTS_PATH=${artifactPath}`,
    "--env",
    `ARTIFACTS_DIR=${artifactsDir}`,
  ];
  for (const [key, value] of Object.entries({
    ARTIFACTS_HISTORY_DB: opts.historyPath,
    ARTIFACTS_VERSION: opts.versionId ?? "",
    ARTIFACTS_EVENT: opts.eventId ?? "",
  })) {
    if (value !== undefined) args.push("--env", `${key}=${value}`);
  }
  if ((placement === "split" || placement === "zoomed") && opts.targetPaneId) {
    args.push("--target-pane", opts.targetPaneId);
  }
  if (placement === "tab" && opts.workspaceId) {
    args.push("--workspace", opts.workspaceId);
  }
  if (placement === "split") {
    args.push("--direction", opts.direction ?? "right");
  }
  args.push(opts.focus === false ? "--no-focus" : "--focus");
  return args;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirnameSafe(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function dirnameSafe(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? "." : path.slice(0, index);
}
