import { expect, test } from "bun:test";

import { PLUGIN_ROOT } from "../src/paths";

test(
  "opens a compiled canvas through a real Herdr PTY in Docker",
  async () => {
    if (process.env.HERDR_E2E === "1") {
      const inner = Bun.spawn(["bun", `${PLUGIN_ROOT}/e2e/inside.ts`], {
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      expect(await inner.exited).toBe(0);
      return;
    }

    const build = Bun.spawn(["docker", "build", "-t", "herdr-canvas-e2e", "."], {
      cwd: PLUGIN_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(await build.exited).toBe(0);

    const run = Bun.spawn(["docker", "run", "--rm", "-e", "HERDR_E2E=1", "herdr-canvas-e2e"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(await run.exited).toBe(0);
  },
  { timeout: 10 * 60 * 1000 },
);
