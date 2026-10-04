import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { artifactsDirFrom } from "./artifactFile";
import { writePluginPackage } from "./plugin-package";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function destination() {
  const root = await mkdtemp(join(tmpdir(), "artifacts-plugin-"));
  temporaryDirectories.push(root);
  return join(root, "plugin");
}
async function config(directory: string) {
  return JSON.parse(await readFile(join(directory, "mcp.json"), "utf8"));
}

describe("portable plugin package", () => {
  test("materializes discoverable skills and a configured local stdio transport", async () => {
    const directory = await destination();
    const workspace = join(directory, "..", "source files");
    expect(await writePluginPackage({ directory, workspace })).toEqual({ directory });
    const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("artifacts");
    expect(Object.keys(manifest).sort()).toEqual(["$schema", "author", "description", "extensions", "license", "name", "repository", "version"]);
    const onboarding = manifest.extensions["com.openai"].onboardingSkill;
    expect(onboarding).toBe("./skills/setup/SKILL.md");
    expect(await readFile(join(directory, onboarding), "utf8")).toContain("name: setup");
    expect(await readFile(join(directory, "skills/author/SKILL.md"), "utf8")).toContain("name: author");
    expect((await readdir(directory)).sort()).toEqual(["mcp.json", "plugin.json", "skills"]);
    expect(await config(directory)).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { artifacts: { type: "stdio", command: "bunx", args: ["--bun", "@sidequery/artifacts@0.1.0", "mcp", "--dir", resolve(workspace)] } },
    });
  });

  test("captures the CLI's actual default source directory", async () => {
    const directory = await destination();
    await writePluginPackage({ directory });
    expect((await config(directory)).mcpServers.artifacts.args.slice(-2)).toEqual(["--dir", resolve(artifactsDirFrom(process.cwd()))]);
  });

  test.each(["https://artifacts.example.test/mcp", "http://127.0.0.1:4786/mcp", "http://localhost:4786/mcp", "http://[::1]:4786/mcp"])("uses remote transport for explicit endpoint %s", async url => {
    const directory = await destination();
    await writePluginPackage({ directory, url });
    expect((await config(directory)).mcpServers.artifacts).toEqual({ type: "streamable-http", url });
  });

  test.each(["http://artifacts.example.test/mcp", "https://user:secret@example.test/mcp", "https://example.test/mcp?token=secret", "https://example.test/mcp#secret", "file:///tmp/server", "not-a-url", ""])("rejects unsafe or invalid URL %s before creating output", async url => {
    const directory = await destination();
    await expect(writePluginPackage({ directory, url })).rejects.toThrow();
    expect(await readdir(join(directory, ".."))).toEqual([]);
  });

  test("refuses ambiguous local and remote configuration", async () => {
    await expect(writePluginPackage({ directory: await destination(), workspace: "/tmp/artifacts", url: "https://example.test/mcp" })).rejects.toThrow("not both");
  });

  test("preserves existing files and symlink destinations", async () => {
    const directory = await destination();
    await mkdir(directory);
    await writeFile(join(directory, "user.txt"), "keep me");
    await expect(writePluginPackage({ directory })).rejects.toThrow();
    expect(await readFile(join(directory, "user.txt"), "utf8")).toBe("keep me");
    expect(await readdir(directory)).toEqual(["user.txt"]);
    const link = join(directory, "..", "link");
    await symlink(directory, link);
    await expect(writePluginPackage({ directory: link })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["user.txt"]);
  });

  test("cleans its own partial output after a write failure", async () => {
    const directory = await destination();
    const originalWrite = filesystem.writeFile;
    const write = spyOn(filesystem, "writeFile").mockImplementation(async (...args) => {
      if (args[0] === join(directory, "mcp.json")) throw new Error("simulated disk failure");
      return originalWrite(...args);
    });
    try {
      await expect(writePluginPackage({ directory })).rejects.toThrow("simulated disk failure");
      expect(await readdir(join(directory, ".."))).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  test("concurrent attempts have one winner and preserve its complete output", async () => {
    const directory = await destination();
    const results = await Promise.allSettled([writePluginPackage({ directory }), writePluginPackage({ directory })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await config(directory)).mcpServers.artifacts.type).toBe("stdio");
    expect(await readFile(join(directory, "skills/author/SKILL.md"), "utf8")).toContain("name: author");
  });
});

test("CLI generates remote/local packages without initializing a workspace and rejects incomplete flags", async () => {
  const directory = await destination();
  const root = join(directory, "..");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, "plugin", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  const remote = await run(["--out", directory, "--url", "https://example.test/mcp"]);
  expect(remote.exitCode).toBe(0);
  expect(JSON.parse(remote.stdout)).toEqual({ directory });
  expect((await config(directory)).mcpServers.artifacts).toEqual({ type: "streamable-http", url: "https://example.test/mcp" });
  const local = await run(["--out", join(root, "local"), "--dir", join(root, "source")]);
  expect(local.exitCode).toBe(0);
  expect((await config(join(root, "local"))).mcpServers.artifacts.args.slice(-2)).toEqual(["--dir", join(root, "source")]);
  const missing = await run(["--out", join(root, "invalid"), "--url"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("--url requires a value");
  expect((await readdir(root)).sort()).toEqual(["local", "plugin"]);
});
