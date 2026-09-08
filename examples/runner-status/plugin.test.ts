import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runnerStatusPlugin } from "./plugin";
import { preparePlugins } from "../../scripts/prepare-plugins";

const user = { subject: "alice", authority: "https://team.cloudflareaccess.com" };
test("allows only exact configured identities and denies by default", async () => {
  const operation = runnerStatusPlugin({ allowedUsers: [user] }).operations!.getStatus!;
  expect(await operation.authorize!(user)).toBe(true);
  expect(await operation.authorize!({ ...user, subject: "bob" })).toBe(false);
  expect(await operation.authorize!({ ...user, authority: "other" })).toBe(false);
  expect(await runnerStatusPlugin({ allowedUsers: [] }).operations!.getStatus!.authorize!(user)).toBe(false);
});

test("forwards collector authentication only server-side and rejects redirects and invalid URLs", async () => {
  const signal = new AbortController().signal;
  const operation = runnerStatusPlugin({ allowedUsers: [user] }).operations!.getStatus!;
  const secrets = { RUNNER_STATUS_URL: "https://collector.example/api/status", RUNNER_STATUS_TOKEN: "fixture-token" };
  const snapshot = { org: "example", repos: [], runners: [], jobs: [], sources: [], runnerFetchedAt: null, checkedAt: new Date().toISOString(), errors: [], refreshSeconds: 45 };
  let status = 200;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(secrets.RUNNER_STATUS_URL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBe(signal);
    return Response.json(snapshot, { status });
  });
  try {
    expect(await operation.handler({}, { user, secrets, signal })).toEqual(snapshot);
    status = 302;
    await expect(operation.handler({}, { user, secrets, signal })).rejects.toThrow("unavailable");
    for (const url of ["http://collector.example/api/status", "https://user:pass@collector.example/api/status", "https://collector.example/api/status?token=bad", "https://collector.example/other"]) {
      await expect(operation.handler({}, { user, secrets: { ...secrets, RUNNER_STATUS_URL: url }, signal })).rejects.toThrow("Invalid collector URL");
    }
    expect(mocked).toHaveBeenCalledTimes(2);
  } finally { mocked.mockRestore(); }
});

test("sample compiles to discoverable read-only MCP catalog and validates its empty input", async () => {
  const output = await mkdtemp(join(tmpdir(), "runner-plugin-"));
  try {
    const built = await preparePlugins(join(import.meta.dir, "../.."), output, "examples/runner-status/artifacts.plugins.ts");
    expect(built.catalog[0]).toMatchObject({ name: "github-runners", operations: [{ name: "getStatus", readOnly: true }] });
    const catalog = await readFile(join(output, "plugin-catalog.json"), "utf8");
    expect(catalog).not.toContain("RUNNER_STATUS_TOKEN");
    const validators = await import(join(output, "plugin-validators.js"));
    expect(validators.validatePluginInput("github-runners", "getStatus", {})).toBe(true);
    expect(validators.validatePluginInput("github-runners", "getStatus", { org: "other" })).toBe(false);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("loopback collector requires bearer authentication and exact local authorization", async () => {
  const plugin = runnerStatusPlugin({ allowedUsers: [{ subject: "local", authority: "local" }], allowLoopback: true });
  expect(plugin.secrets).toEqual(["RUNNER_STATUS_URL", "RUNNER_STATUS_TOKEN"]);
  const operation = plugin.operations!.getStatus!;
  expect(await operation.authorize!({ subject: "local", authority: "local" })).toBe(true);
  expect(await operation.authorize!(user)).toBe(false);
  const context = { user: { subject: "local", authority: "local" }, secrets: { RUNNER_STATUS_URL: "http://127.0.0.1:4786/api/status", RUNNER_STATUS_TOKEN: "local-token" }, signal: new AbortController().signal };
  const mocked = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-token");
    expect(init?.redirect).toBe("manual");
    return Response.json({ org: "example" });
  });
  try {
    expect(await operation.handler({}, context)).toEqual({ org: "example" });
    for (const url of ["http://example.com/api/status", "http://127.0.0.1.example.com/api/status", "http://localhost/api/status", "http://user:pass@127.0.0.1/api/status"]) {
      await expect(operation.handler({}, { ...context, secrets: { ...context.secrets, RUNNER_STATUS_URL: url } })).rejects.toThrow("Invalid collector URL");
    }
    await expect(runnerStatusPlugin({ allowedUsers: [user] }).operations!.getStatus!.handler({}, context)).rejects.toThrow("Invalid collector URL");
    expect(mocked).toHaveBeenCalledTimes(1);
  } finally { mocked.mockRestore(); }
});
