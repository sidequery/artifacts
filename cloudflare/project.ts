import { createHash } from "node:crypto";
import { valid, satisfies, maxSatisfying } from "semver";

export type ArtifactProject = { files: Record<string, string>; dependencies: Record<string, string>; lock: Record<string, string> };
export const emptyProject = (): ArtifactProject => ({ files: {}, dependencies: {}, lock: {} });
const size = (value: string) => new TextEncoder().encode(value).byteLength;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const reserved = new Set(["artifact.artifact.tsx", "artifact.artifact.server.ts", "script.ts", "entry.ts", "server-entry.ts", "package.json", "__proto__", "constructor", "prototype"]);
function record(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result: Record<string,string> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string,unknown>)[key];
    if (typeof item !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`invalid ${label} entry: ${key}`);
    result[key] = item;
  }
  return result;
}
export function normalizeProject(input: unknown): ArtifactProject {
  if (input === undefined || input === null) return emptyProject();
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("project must be an object");
  const value = input as Record<string,unknown>;
  for (const key of Object.keys(value)) if (!["files", "dependencies", "lock"].includes(key)) throw new Error(`unknown project field: ${key}`);
  const files = record(value.files ?? {}, "files"), dependencies = record(value.dependencies ?? {}, "dependencies"), lock = record(value.lock ?? {}, "lock");
  if (Object.keys(files).length > 64 || size(JSON.stringify(files)) > 1024 * 1024) throw new Error("project files exceed 64 files or 1 MiB");
  for (const path of Object.keys(files)) {
    if (!/^[a-zA-Z0-9_./-]+\.(?:[cm]?[jt]sx?|json)$/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part === "node_modules") || reserved.has(path)) throw new Error(`invalid project file path: ${path}`);
  }
  if (Object.keys(dependencies).length > 32) throw new Error("project exceeds 32 direct dependencies");
  for (const [name, version] of Object.entries(dependencies)) if (!packageName.test(name) || valid(version) !== version) throw new Error(`dependency ${name} requires an exact semver version, not a tag, URL, or range`);
  if (Object.keys(lock).length > 4096 || size(JSON.stringify(lock)) > 8 * 1024 * 1024) throw new Error("dependency lock exceeds 4096 files or 8 MiB");
  for (const path of Object.keys(lock)) if (!path.startsWith("node_modules/") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`invalid dependency lock path: ${path}`);
  return { files, dependencies, lock };
}
export function projectSourceHash(source: string, project: ArtifactProject): string {
  return createHash("sha256").update(Object.values(project).every(value => Object.keys(value).length === 0) ? source : JSON.stringify([source, project])).digest("hex");
}

type Manifest = { name: string; version: string; dependencies?: Record<string,string>; peerDependencies?: Record<string,string>; peerDependenciesMeta?: Record<string,{optional?:boolean}>; dist?: { tarball: string; integrity?: string } };
type Registry = { versions: Record<string,Manifest> };
const registryOrigin = "https://registry.npmjs.org";
async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) throw new Error("empty npm response");
  const reader = body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) throw new Error(`npm response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function download(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.origin !== registryOrigin || parsed.username || parsed.password) throw new Error("packages must come from registry.npmjs.org");
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Accept: "application/vnd.npm.install-v1+json" } });
  if (!response.ok) throw new Error(`npm request failed (${response.status}) for ${parsed.pathname}`);
  return boundedBody(response.body, 8 * 1024 * 1024);
}
export async function packageFiles(manifest: Manifest, fetcher: typeof fetch): Promise<Record<string,string>> {
  if (!manifest.dist?.tarball || !manifest.dist.integrity) throw new Error(`${manifest.name}@${manifest.version} has no integrity-protected tarball`);
  const compressed = await download(manifest.dist.tarball, fetcher);
  const integrity = manifest.dist.integrity.split(/\s+/).find(value => /^sha512-/.test(value)) ?? manifest.dist.integrity.split(/\s+/).find(value => /^sha256-/.test(value));
  if (!integrity) throw new Error(`unsupported integrity algorithm for ${manifest.name}`);
  const [algorithm, expected] = integrity.split("-");
  if (createHash(algorithm!).update(compressed).digest("base64") !== expected) throw new Error(`npm integrity mismatch for ${manifest.name}@${manifest.version}`);
  const decompressed = new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const data = await boundedBody(decompressed, 24 * 1024 * 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }), files: Record<string,string> = {};
  const text = (start: number, length: number) => new TextDecoder().decode(data.subarray(start,start+length)).replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= data.length;) {
    if (data.subarray(offset,offset+512).every(value => value === 0)) break;
    const prefix = text(offset + 345, 155), name = text(offset,100), path = `${prefix ? `${prefix}/` : ""}${name}`;
    const length = parseInt(text(offset+124,12).trim(),8), type = data[offset+156];
    if (!Number.isSafeInteger(length) || length < 0 || offset+512+length > data.length) throw new Error("invalid npm tar archive");
    offset += 512;
    if (type === 0 || type === 48) {
      if (!path.startsWith("package/") || path.includes("\\") || path.split("/").some(part => part === ".." || part === ".")) throw new Error("unsafe npm tar path");
      const relative = path.slice(8);
      if (/\.(?:[cm]?[jt]sx?|json)$/.test(relative)) files[`node_modules/${manifest.name}/${relative}`] = decoder.decode(data.subarray(offset,offset+length));
    } else if (type !== 53) throw new Error(`unsupported npm tar entry in ${manifest.name}`);
    offset += Math.ceil(length/512)*512;
  }
  return files;
}
/** Resolve once at authoring time. Replay and execution consume this immutable source snapshot without network requests. */
export async function resolveProject(input: unknown, previous?: ArtifactProject, fetcher: typeof fetch = fetch, hostPackages: Record<string,string> = {}): Promise<ArtifactProject> {
  const requested = normalizeProject(input);
  // Callers may reuse an existing lock, but cannot upload executable vendor code disguised as registry packages.
  if (Object.keys(requested.lock).length) throw new Error("project.lock is read-only; submit files and dependencies");
  if (previous && JSON.stringify(previous.dependencies) === JSON.stringify(requested.dependencies)) return normalizeProject({ ...requested, lock: previous.lock });
  const manifests = new Map<string,Manifest>(), pending = new Map<string,Registry>();
  const install = async (name: string, range: string, requestedBy: string): Promise<void> => {
    if (!packageName.test(name)) throw new Error(`unsupported dependency ${name} requested by ${requestedBy}`);
    if (hostPackages[name]) {
      if (!satisfies(hostPackages[name]!, range)) throw new Error(`${requestedBy} requires ${name}@${range}, but Artifact supplies ${name}@${hostPackages[name]}; choose a compatible package version`);
      return;
    }
    const existing = manifests.get(name);
    if (existing) {
      if (!satisfies(existing.version, range)) throw new Error(`dependency conflict: ${requestedBy} requires ${name}@${range}, but ${name}@${existing.version} is already selected; this compiler supports one version per package`);
      return;
    }
    if (manifests.size >= 64) throw new Error("project exceeds 64 resolved packages");
    let metadata = pending.get(name);
    if (!metadata) { metadata = JSON.parse(new TextDecoder().decode(await download(`${registryOrigin}/${name.replace("/", "%2f")}`,fetcher))) as Registry; pending.set(name,metadata); }
    const version = maxSatisfying(Object.keys(metadata.versions ?? {}), requested.dependencies[name] ?? range);
    if (version && !satisfies(version, range)) throw new Error(`dependency conflict: ${requestedBy} requires ${name}@${range}, but project pins ${name}@${version}`);
    if (!version) throw new Error(`cannot resolve ${name}@${range} required by ${requestedBy}`);
    const manifest = metadata.versions[version]!;
    if (manifest.name !== name || manifest.version !== version) throw new Error("npm manifest identity mismatch");
    manifests.set(name,manifest);
    Object.assign(requested.lock,await packageFiles(manifest,fetcher));
    normalizeProject(requested);
    for (const [dep, constraint] of Object.entries(manifest.dependencies ?? {}).sort()) await install(dep,constraint,`${name}@${version}`);
  };
  for (const [name, version] of Object.entries(requested.dependencies)) await install(name,version,"project");
  for (const manifest of manifests.values()) for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (hostPackages[name] && satisfies(hostPackages[name]!,range)) continue;
    if (!manifests.has(name) && manifest.peerDependenciesMeta?.[name]?.optional) continue;
    if (!manifests.has(name) || !satisfies(manifests.get(name)!.version,range)) throw new Error(`${manifest.name}@${manifest.version} requires peer ${name}@${range}; declare a compatible exact version in project.dependencies`);
  }
  return normalizeProject(requested);
}
