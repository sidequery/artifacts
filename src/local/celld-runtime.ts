import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.4.1";
type Artifact = { target: string; archiveSha256: string; binarySha256: string };
// Archive digests from the GitHub v0.4.1 release API; executable digests computed
// from those verified archives. Pin both so cached executables are checked too.
const artifacts: Record<string, Artifact> = {
  "darwin-arm64": { target: "aarch64-apple-darwin", archiveSha256: "95c689769f66c08fd0d191fbfc731adb4c8340b49678b11979698ecf2e73393d", binarySha256: "12865054bc0438f8e3dcdaf0e38194ff73f5609794fa2352cfa9005f7831f344" },
  "linux-arm64": { target: "aarch64-unknown-linux-gnu", archiveSha256: "5cc2281493a896b2cc7c7b6c46b2188753832d6b028457338c8eea774a1dd9a1", binarySha256: "bf2546c163e925120ab4df2de1bf4b510f84fbb8e51ab85a074eb5b052423148" },
  "linux-x64": { target: "x86_64-unknown-linux-gnu", archiveSha256: "7b42a410e340bca4dbadd08ecb7f8983854aa855aa7467c29ab0e08b8b7f2007", binarySha256: "e499e6d8e1bb04297252bd4df661bc4429293144fe6f20e02a51d12f1e23b161" },
};

export function celldArtifact(platform: string = process.platform, arch: string = process.arch): Artifact {
  const artifact = artifacts[`${platform}-${arch}`];
  if (!artifact) throw new Error(`Managed celld ${CELLD_VERSION} does not support ${platform}/${arch}. Available: macOS arm64 and Linux glibc arm64/x64. Other Canvas commands do not require celld.`);
  return artifact;
}

export function canvasDataRoot(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home = homedir()): string {
  if (env.CANVAS_DATA_HOME) return resolve(env.CANVAS_DATA_HOME);
  const base = platform === "darwin" ? join(home, "Library", "Application Support") : env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(base, "sidequery-canvas");
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function ensureCelldRuntime(options: {
  dataRoot: string;
  signal?: AbortSignal;
  notify?: (message: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  artifact?: Artifact;
}): Promise<string> {
  const artifact = options.artifact ?? celldArtifact();
  const executable = join(options.dataRoot, "runtimes", "celld", CELLD_VERSION, artifact.target, "celld");
  try {
    const bytes = await readFile(executable);
    if (sha256(bytes) !== artifact.binarySha256) throw new Error(`Cached celld checksum mismatch: ${executable}. Remove that managed executable and retry.`);
    await chmod(executable, 0o700);
    return executable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  options.signal?.throwIfAborted();
  options.notify?.(`Downloading celld ${CELLD_VERSION} for ${artifact.target}…`);
  const response = await (options.fetch ?? globalThis.fetch)(`https://github.com/denoland/celld/releases/download/v${CELLD_VERSION}/celld-${artifact.target}.gz`, {
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`celld download failed: HTTP ${response.status}`);
  const compressed = new Uint8Array(await response.arrayBuffer());
  if (sha256(compressed) !== artifact.archiveSha256) throw new Error("celld archive checksum mismatch; nothing was installed");
  const binary = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  if (sha256(binary) !== artifact.binarySha256) throw new Error("celld executable checksum mismatch; nothing was installed");
  options.signal?.throwIfAborted();
  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  const temporary = `${executable}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, binary, { mode: 0o700, flag: "wx" });
    await rename(temporary, executable);
  } finally {
    await rm(temporary, { force: true });
  }
  return executable;
}
