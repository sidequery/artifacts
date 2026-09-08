import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PLUGIN_ROOT } from "./paths";

export function historyPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_CANVAS_HISTORY_DB) return resolve(env.HERDR_CANVAS_HISTORY_DB);
  const root = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "herdr-canvas", "history.sqlite");
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Include implementation identity because this plugin may be an unversioned local link.
export function runtimeIdentity(): string {
  const files = ["package.json", "src/compile.ts", "src/html.ts"];
  // Registry tarballs intentionally omit package-manager lockfiles. Include the
  // checkout lock when available without making installed-package previews depend on it.
  if (existsSync(join(PLUGIN_ROOT, "bun.lock"))) files.push("bun.lock");
  if (existsSync(join(PLUGIN_ROOT, "dist/cloudflare/plugin-browser.json"))) files.push("dist/cloudflare/plugin-browser.json");
  for (const dir of ["src/sdk", "src/runtime", "src/plugins"]) {
    for (const name of readdirSync(join(PLUGIN_ROOT, dir)).sort()) {
      if (!name.includes(".test.")) files.push(`${dir}/${name}`);
    }
  }
  const manifestPath = join(PLUGIN_ROOT, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  const requireFromPlugin = createRequire(manifestPath);
  const dependencies = Object.fromEntries(["react", "react-dom", "react-router", "typescript"].map(name => {
    const dependency = JSON.parse(readFileSync(requireFromPlugin.resolve(`${name}/package.json`), "utf8")) as { version: string };
    return [name, dependency.version];
  }));
  return JSON.stringify({
    bun: Bun.version,
    plugin: manifest.version,
    dependencies,
    sdkHash: hash(files.map(file => `${file}\0${readFileSync(join(PLUGIN_ROOT, file), "utf8")}`).join("\0")),
  });
}

export type { Version, ServeEvent, HistoryEntry } from "./historyTypes";
import type { Version, ServeEvent, HistoryEntry } from "./historyTypes";

export class CanvasHistory {
  readonly db: Database;
  constructor(readonly path = historyPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma foreign_keys = on;");
    const version = (this.db.query("pragma user_version").get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error("Canvas history database is newer than this application"); }
    this.db.transaction(() => {
      this.db.exec(`
        create table if not exists artifacts (
          id text primary key, workspace text not null, name text not null,
          source_path text not null, created_at text not null,
          unique(workspace, name)
        );
        create table if not exists versions (
          id text primary key, artifact_id text not null references artifacts(id),
          revision integer not null, source text not null, source_hash text not null,
          runtime text not null,
          created_at text not null, reason text not null,
          restored_from text references versions(id), unique(artifact_id, revision)
        );
        create table if not exists serve_events (
          id text primary key, version_id text not null references versions(id),
          served_at text not null, pane_id text, session_id text,
          mode text not null, initial_state text not null, runtime text not null
        );
        create table if not exists artifact_remixes (
          artifact_id text primary key references artifacts(id),
          source_version_id text not null references versions(id)
        );
        create index if not exists serve_events_version on serve_events(version_id, served_at);
        pragma user_version = 1;
      `);
    }).immediate();
  }

  close() { this.db.close(); }

  capture(input: { workspace: string; name: string; sourcePath: string; source: string; runtime: string; reason?: string; restoredFrom?: string; force?: boolean }): Version {
    return this.db.transaction(() => {
      const workspace = resolve(input.workspace);
      this.db.query("insert or ignore into artifacts values (?, ?, ?, ?, ?)").run(randomUUID(), workspace, input.name, resolve(input.sourcePath), new Date().toISOString());
      const artifact = this.db.query("select id from artifacts where workspace = ? and name = ?").get(workspace, input.name) as { id: string };
      const sourceHash = hash(input.source);
      const latest = this.db.query("select id, revision, source_hash from versions where artifact_id = ? order by revision desc limit 1").get(artifact.id) as Version | null;
      if (!input.force && latest && latest.source_hash === sourceHash) return this.version(latest.id)!;
      const id = randomUUID();
      this.db.query("insert into versions values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, artifact.id, (latest?.revision ?? 0) + 1, input.source, sourceHash, input.runtime, new Date().toISOString(), input.reason ?? "served", input.restoredFrom ?? null);
      return this.version(id)!;
    }).immediate();
  }

  origin(artifactId: string) {
    return this.db.query(`select a.name as source_name, a.id as source_artifact_id, v.id as source_version_id
      from artifact_remixes r join versions v on v.id = r.source_version_id
      join artifacts a on a.id = v.artifact_id where r.artifact_id = ?`).get(artifactId);
  }

  version(id: string, workspace?: string): Version | null {
    const result = this.db.query(`select v.*, a.workspace, a.name, a.source_path from versions v
      join artifacts a on a.id = v.artifact_id where v.id = ?`).get(id) as Version | null;
    return result && (!workspace || result.workspace === resolve(workspace)) ? result : null;
  }

  list(workspace?: string, name?: string): HistoryEntry[] {
    return this.db.query(`select a.id as artifact_id, a.name, a.source_path, a.workspace, v.id as version_id,
      v.revision, v.created_at, v.source_hash, v.runtime, v.reason, v.restored_from,
      (select count(*) from serve_events e where e.version_id = v.id) as serve_count
      from artifacts a join versions v on v.artifact_id = a.id
      where (? is null or a.workspace = ?) and (? is null or a.name = ?) order by a.name, v.revision desc`).all(workspace ? resolve(workspace) : null, workspace ? resolve(workspace) : null, name ?? null, name ?? null) as HistoryEntry[];
  }

  served(versionId: string, state: Record<string, unknown>, mode: "live" | "replay" | "preview", env: NodeJS.ProcessEnv = process.env, runtime = "unknown"): string {
    const id = randomUUID();
    this.db.query("insert into serve_events values (?, ?, ?, ?, ?, ?, ?, ?)").run(id, versionId, new Date().toISOString(), env.HERDR_PANE_ID ?? null, env.HERDR_SESSION_ID ?? env.HERDR_WORKSPACE_ID ?? null, mode, JSON.stringify(state), runtime);
    return id;
  }

  events(versionId: string): ServeEvent[] {
    return this.db.query("select * from serve_events where version_id = ? order by rowid desc").all(versionId) as ServeEvent[];
  }
}
