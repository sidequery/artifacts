import { expect, test } from "bun:test";

import { openArtifact } from "./open";
import { FORBIDDEN_IMPORT_ARTIFACT, VALID_ARTIFACT, tempDir, writeArtifact } from "./test/fixtures";

test("openArtifact refuses a sandboxed-invalid artifact without contacting Herdr", async () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "bad", FORBIDDEN_IMPORT_ARTIFACT);
  const result = await openArtifact(path, { artifactsDir: dir });
  expect(result.ok).toBe(false);
  expect(result.opened).toBe("none");
  expect(result.check).toContain("Artifact TypeScript check:");
});

test("openArtifact opens herdr.artifacts without starting a detached server", async () => {
  const dir = tempDir();
  const path = writeArtifact(dir, "overview", VALID_ARTIFACT);
  const calls: string[][] = [];
  const result = await openArtifact(path, {
    artifactsDir: dir,
    ensureServer: async () => {
      throw new Error("normal Artifact opens must not start the detached server");
    },
    herdr: {
      bin: "herdr",
      run(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify({ result: { plugin_pane: { plugin_id: "herdr.artifacts" } } }),
          stderr: "",
        };
      },
    },
    env: {
      HERDR_WORKSPACE_ID: "w15",
      HERDR_PANE_ID: "w15:p1",
    },
  });
  expect(result.ok).toBe(true);
  expect(result.opened).toBe("artifact-pane");
  expect(result.url).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("herdr.artifacts");
  expect(calls[0]).toContain("ARTIFACTS_PATH=" + path);
  expect(calls[0]).toContain("ARTIFACTS_DIR=" + dir);
  expect(calls[0]).toContain("--target-pane");
  expect(calls[0]).toContain("w15:p1");
  expect(calls[0]).not.toContain("--workspace");
});
