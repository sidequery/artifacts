import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { artifactDataRoot, celldArtifact, ensureCelldRuntime } from "./celld-runtime";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "artifact-runtime-test-"));
  directories.push(dataRoot);
  const binary = Buffer.from("#!/bin/sh\nprintf 'celld 0.4.1\\n'\n");
  const compressed = gzipSync(binary);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return { dataRoot, binary, compressed, artifact: { target: "fixture", archiveSha256: hash(compressed), binarySha256: hash(binary) } };
}

test("selects only released native platforms and keeps app data outside the checkout", () => {
  expect(celldArtifact("darwin", "arm64").target).toBe("aarch64-apple-darwin");
  expect(celldArtifact("linux", "arm64").target).toBe("aarch64-unknown-linux-gnu");
  expect(celldArtifact("linux", "x64").target).toBe("x86_64-unknown-linux-gnu");
  for (const [platform, arch] of [["darwin", "x64"], ["win32", "x64"], ["linux", "riscv64"]]) {
    expect(() => celldArtifact(platform, arch)).toThrow("does not support");
  }
  expect(artifactDataRoot({}, "darwin", "/users/test")).toBe("/users/test/Library/Application Support/sidequery-artifacts");
  expect(artifactDataRoot({}, "linux", "/users/test")).toBe("/users/test/.local/share/sidequery-artifacts");
  expect(artifactDataRoot({ XDG_DATA_HOME: "/data" }, "linux", "/users/test")).toBe("/data/sidequery-artifacts");
  expect(artifactDataRoot({ ARTIFACTS_DATA_HOME: "/custom" }, "darwin", "/users/test")).toBe("/custom");
});

test("downloads a verified executable once, works offline thereafter, and repairs executable mode", async () => {
  const f = await fixture();
  let calls = 0;
  const fetcher = (async (url: string | URL | Request) => { calls++; expect(String(url)).toEndWith("/v0.4.1/celld-fixture.gz"); return new Response(f.compressed); });
  const executable = await ensureCelldRuntime({ ...f, fetch: fetcher });
  expect(await readFile(executable)).toEqual(f.binary);
  expect((await stat(executable)).mode & 0o777).toBe(0o700);
  const child = Bun.spawn([executable], { stdout: "pipe" });
  expect(await new Response(child.stdout).text()).toBe("celld 0.4.1\n");
  expect(await child.exited).toBe(0);
  expect(await ensureCelldRuntime({ ...f, fetch: (async () => { throw new Error("offline"); }) })).toBe(executable);
  expect(calls).toBe(1);
  await writeFile(executable, "changed");
  await expect(ensureCelldRuntime({ ...f, fetch: fetcher })).rejects.toThrow("Cached celld checksum mismatch");
  expect(calls).toBe(1);
});

test("rejects HTTP, archive, and decompressed integrity failures before installing", async () => {
  const f = await fixture();
  await expect(ensureCelldRuntime({ ...f, fetch: (async () => new Response("unavailable", { status: 503 })) })).rejects.toThrow("HTTP 503");
  await expect(ensureCelldRuntime({ ...f, fetch: (async () => new Response("bad bytes")) })).rejects.toThrow("archive checksum mismatch");
  await expect(ensureCelldRuntime({ ...f, artifact: { ...f.artifact, binarySha256: "wrong" }, fetch: (async () => new Response(f.compressed)) })).rejects.toThrow("executable checksum mismatch");
  expect(await Bun.file(join(f.dataRoot, "runtimes/celld/0.4.1/fixture/celld")).exists()).toBe(false);
});

test("concurrent verified installs publish one complete executable", async () => {
  const f = await fixture();
  const options = { ...f, fetch: (async () => new Response(f.compressed)) };
  const paths = await Promise.all([ensureCelldRuntime(options), ensureCelldRuntime(options)]);
  expect(paths[0]).toBe(paths[1]);
  expect(await readFile(paths[0])).toEqual(f.binary);
});

test("cancellation does not download or install", async () => {
  const f = await fixture();
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(ensureCelldRuntime({ ...f, signal, fetch: (async () => { throw new Error("must not fetch"); }) })).rejects.toThrow("cancelled");
});

test("native data root reuses the original server state and honors new overrides first", async () => {
  const f = await fixture(), home = f.dataRoot, base = join(home, ".local", "share");
  const legacy = join(base, "sidequery-canvas"), current = join(base, "sidequery-artifacts");
  await mkdir(join(legacy, "server"), { recursive: true });
  expect(artifactDataRoot({}, "linux", home)).toBe(legacy);
  expect(artifactDataRoot({ CANVAS_DATA_HOME: legacy }, "linux", home)).toBe(legacy);
  expect(artifactDataRoot({ CANVAS_DATA_HOME: legacy, ARTIFACTS_DATA_HOME: current }, "linux", home)).toBe(current);
  await mkdir(current);
  expect(artifactDataRoot({}, "linux", home)).toBe(current);
});
