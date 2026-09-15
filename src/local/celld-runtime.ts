import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const CELLD_VERSION = "0.5.0";
type Artifact = { target: string; archiveSha256: string; binarySha256: string };
// Archive digests from the GitHub v0.5.0 release API; executable digests computed
// from those verified archives. Pin both so cached executables are checked too.
const artifacts: Record<string, Artifact> = {
  "darwin-arm64": { target: "aarch64-apple-darwin", archiveSha256: "07f6dbded0a2ffe3d7626842908ea81ed517fe94b0cfae784fd0c053d8952e80", binarySha256: "77e5d6f129c1bf49e8d71ac5b68298fb8c8c247392add28a90c4cca6d9957786" },
  "linux-arm64": { target: "aarch64-unknown-linux-gnu", archiveSha256: "bd3965f78f96c755b64b0280746a7c26116fa9df01a9e57c5930e9752945c993", binarySha256: "9942da9973a0ca15260921295bbbdbb80a2f66f2eccac4984e748aefc252bd7e" },
  "linux-x64": { target: "x86_64-unknown-linux-gnu", archiveSha256: "1039eee3737bb432ca0cd399fc55cc0aab4e653b2beae26009e455fea4e5334c", binarySha256: "ca451f33a58a393ec580a186af4f0ef8e9b9e665d253f1f95a7d556213b33bea" },
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
