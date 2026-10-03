import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.6.1";
type Artifact = { target: string; archiveSha256: string; binarySha256: string };
// Archive digests from the GitHub v0.6.1 release API; executable digests computed
// from those verified archives. Pin both so cached executables are checked too.
const artifacts: Record<string, Artifact> = {
  "darwin-arm64": { target: "aarch64-apple-darwin", archiveSha256: "3033cc4f428433f4239ac616a04092cd4b6c7db19f2f5ba9926c86ec56c34c95", binarySha256: "91f6d7a470720c300efddf75e666f121c0f51bbaf7a245d9d76efffaefeecf57" },
  "linux-arm64": { target: "aarch64-unknown-linux-gnu", archiveSha256: "ab99053bcced225bb5b54f428792260c905b782b8a61947362a12ce3a9c22def", binarySha256: "45827115ef4e05527a1d0aa5ac8c64d75fc6a8d1dcde9c837e97f67898aa0e98" },
  "linux-x64": { target: "x86_64-unknown-linux-gnu", archiveSha256: "79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b", binarySha256: "810b2a0b70e3420daee80f1d5378de5ba28651f0371ec7aa70b6c5de77e70d9e" },
};

export function celldArtifact(platform: string = process.platform, arch: string = process.arch): Artifact {
  const artifact = artifacts[`${platform}-${arch}`];
  if (!artifact) throw new Error(`Managed celld ${CELLD_VERSION} does not support ${platform}/${arch}. Available: macOS arm64 and Linux glibc arm64/x64. Other Artifact commands do not require celld.`);
  return artifact;
}

export function artifactDataRoot(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home = homedir()): string {
  if (env.ARTIFACTS_DATA_HOME || env.CANVAS_DATA_HOME) return resolve(env.ARTIFACTS_DATA_HOME || env.CANVAS_DATA_HOME!);
  const base = platform === "darwin" ? join(home, "Library", "Application Support") : env.XDG_DATA_HOME || join(home, ".local", "share");
  const current = join(base, "sidequery-artifacts"), legacy = join(base, "sidequery-canvas");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
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
  if (process.env.ARTIFACTS_BUNDLED_CELLD && !options.artifact) {
    const embedded = resolve(process.env.ARTIFACTS_BUNDLED_CELLD);
    if (sha256(await readFile(embedded)) !== artifact.binarySha256) throw new Error("Bundled celld checksum mismatch");
    await chmod(embedded, 0o700);
    return embedded;
  }
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
