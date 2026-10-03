import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes } from "node:crypto";
import { compileNativeWorker } from "../compiler";
import { emptyProject, resolveProject, type ArtifactProject } from "../project";
import { artifactApiResponse } from "../artifact-api";
import { appScope, parseManifest, planResources, type AppManifest, type ResourceLedger } from "./manifest";
import { CloudflareNativeProvider, type CloudflareProviderState } from "./cloudflare";
import type { NativeDeployment, NativeRevision, ProviderResult } from "./types";

export type NativeEnvironment = {
  NATIVE_CF_ACCOUNT_ID?: string; NATIVE_CF_API_TOKEN?: string;
  NATIVE_CELLD_OPERATOR_URL?: string; NATIVE_CELLD_OPERATOR_TOKEN?: string; NATIVE_CELLD_TRUSTED_APPS?: string;
};
type Selection = { owner: string; workspace: string; name: string };
type Draft = { source: string; manifest: AppManifest; project: ArtifactProject };
type ProviderState = CloudflareProviderState & { operatorOrigin?: string };
type Row = Selection & { id: string; provider: "cloudflare" | "celld-local"; desired: string | null; active: string | null;
  status: string; stage: string; resources: string; provider_state: string; secrets: string; endpoint: string | null;
  draft: string; operation: string; attempts: number; error: string | null; updated_at: string };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export function nativeProviders(env: NativeEnvironment) {
  return [env.NATIVE_CF_ACCOUNT_ID && env.NATIVE_CF_API_TOKEN ? "cloudflare" : null,
    env.NATIVE_CELLD_OPERATOR_URL && env.NATIVE_CELLD_OPERATOR_TOKEN && env.NATIVE_CELLD_TRUSTED_APPS === "true" ? "celld-local" : null].filter((value): value is "cloudflare" | "celld-local" => value !== null);
}
function selection(input: Selection): Selection {
  for (const key of ["owner", "workspace", "name"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || bytes(value) > (key === "name" ? 255 : 4096)) throw new Error(`Invalid app ${key}`);
  }
  if (/[/\\]/.test(input.name) || [".", ".."].includes(input.name)) throw new Error("Invalid app name");
  return input;
}

/** Sole owner of deployment intent, provider credentials and app secrets. App code receives none of these bindings. */
export class NativeApps extends DurableObject<NativeEnvironment> {
  private readonly sql: SqlStorage;
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(ctx: DurableObjectState, env: NativeEnvironment) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`create table if not exists native_apps (
      id text primary key, owner text not null, workspace text not null, name text not null, provider text not null,
      desired text, active text, status text not null, stage text not null, resources text not null default '{}',
      provider_state text not null, secrets text not null default '{}', endpoint text, draft text not null,
      operation text not null, attempts integer not null default 0, error text, updated_at text not null,
      unique(owner,workspace,name))`);
    this.sql.exec(`create table if not exists native_revisions (
      app text not null, id text not null, snapshot text not null, created_at text not null, primary key(app,id))`);
    // A restarted controller resumes persisted intent. Alarms never create a new logical deployment.
    ctx.blockConcurrencyWhile(async () => {
      if (this.sql.exec("select id from native_apps where status='deploying'").toArray().length) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  private row(input: Selection): Row {
    selection(input);
    const row = this.sql.exec<Row>("select * from native_apps where owner=? and workspace=? and name=?", input.owner, input.workspace, input.name).toArray()[0];
    if (!row) throw new Error("App not found in this library");
    return row;
  }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.mutations.set(id, result);
    void result.finally(() => { if (this.mutations.get(id) === result) this.mutations.delete(id); }).catch(() => {});
    return result;
  }
  private summary(row: Row) {
    return { name: row.name, workspace: row.workspace, provider: row.provider, desired_revision: row.desired, active_revision: row.active,
      revision_token: createHash("sha256").update(row.draft).digest("hex"), status: row.status, stage: row.stage, error: row.error, updated_at: row.updated_at };
  }
  list(input: { owner: string; workspace: string; offset?: number }) {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid app pagination");
    const rows = this.sql.exec<Row>("select * from native_apps where owner=? and workspace=? order by name limit 100 offset ?", input.owner, input.workspace, offset).toArray();
    return { apps: rows.map(row => this.summary(row)), next_offset: rows.length === 100 ? offset + 100 : null, providers: nativeProviders(this.env) };
  }
  read(input: Selection & { revision_id?: string }) {
    const row = this.row(input);
    const revision = input.revision_id ? this.revision(row.id, input.revision_id) : null;
    return { ...this.summary(row), ...(revision ? { source: revision.source, manifest: revision.manifest, project: revision.project ?? emptyProject(), revision_id: revision.id } : JSON.parse(row.draft) as Draft) };
  }
  history(input: Selection & { offset?: number }) {
    const row = this.row(input), offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid app pagination");
    const revisions = this.sql.exec<{ id: string; created_at: string }>("select id,created_at from native_revisions where app=? order by created_at desc,id limit 100 offset ?", row.id, offset).toArray();
    return { revisions, next_offset: revisions.length === 100 ? offset + 100 : null };
  }
  private revision(app: string, id: string): NativeRevision {
    const result = this.sql.exec<{ snapshot: string }>("select snapshot from native_revisions where app=? and id=?", app, id).toArray()[0];
    if (!result) throw new Error("App revision not found");
    return JSON.parse(result.snapshot) as NativeRevision;
  }
  async write(input: Selection & { source: string; manifest: unknown; project?: unknown; provider?: string; expected_revision?: string | null }) {
    selection(input);
    if (typeof input.source !== "string" || bytes(input.source) > 262144) throw new Error("App source exceeds 256 KiB");
    const manifest = parseManifest(input.manifest);
    let row = this.sql.exec<Row>("select * from native_apps where owner=? and workspace=? and name=?", input.owner, input.workspace, input.name).toArray()[0];
    const created = !row;
    if (row && input.expected_revision === null) throw new Error("Project changed since it was loaded. This app already exists.");
    if (!row) {
      const provider = input.provider ?? nativeProviders(this.env)[0];
      if (!nativeProviders(this.env).includes(provider as Row["provider"])) throw new Error("Requested native provider is not configured");
      if (input.expected_revision != null) throw new Error("App revision changed; reload before saving");
      const id = crypto.randomUUID();
      this.sql.exec("insert into native_apps(id,owner,workspace,name,provider,status,stage,provider_state,draft,operation,updated_at) values(?,?,?,?,?,'draft','draft',?,?,?,?)",
        id, input.owner, input.workspace, input.name, provider,
        JSON.stringify({ ids: {}, migrations: {}, gatewayToken: Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, "0")).join(""),
          ...(provider === "cloudflare" ? { accountId: this.env.NATIVE_CF_ACCOUNT_ID } : { operatorOrigin: this.operatorUrl().origin }),
        } satisfies ProviderState),
        JSON.stringify({ source: input.source, manifest, project: emptyProject() }), crypto.randomUUID(), new Date().toISOString());
      row = this.row(input);
    }
    return this.serial(row.id, async () => {
      const current = this.row(input);
      if (input.provider && input.provider !== current.provider) throw new Error("Provider cannot change on an existing app; data transfer requires a separate app");
      if (!created && input.expected_revision !== undefined && input.expected_revision !== this.summary(current).revision_token) throw new Error("Project changed since it was loaded. Reload the app before saving.");
      const previous = JSON.parse(current.draft) as Draft;
      const project = input.project === undefined ? previous.project : await resolveProject(input.project, previous.project);
      return this.prepare(current, { source: input.source, manifest, project });
    });
  }
  private async prepare(row: Row, draft: Draft) {
    const resources = planResources(appScope(row.id, "native"), draft.manifest, JSON.parse(row.resources) as ResourceLedger);
    this.sql.exec("update native_apps set draft=?,updated_at=? where id=?", JSON.stringify(draft), new Date().toISOString(), row.id);
    const compiled = await compileNativeWorker(draft.source, draft.manifest, resources, draft.project);
    if (!compiled.ok || !compiled.js) return { ...this.summary(this.byId(row.id)), ok: false, diagnostics: compiled.diagnostics, applied: true };
    const id = createHash("sha256").update(JSON.stringify({ ...draft, code: compiled.js })).digest("hex");
    const revision: NativeRevision = { id, ...draft, code: compiled.js, created_at: new Date().toISOString() };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("insert or ignore into native_revisions(app,id,snapshot,created_at) values(?,?,?,?)", row.id, id, JSON.stringify(revision), revision.created_at);
      this.sql.exec("update native_apps set resources=? where id=?", JSON.stringify(resources), row.id);
      this.intent(row.id, id);
    });
    return { ...await this.activate(row.id), applied: true };
  }
  private byId(id: string): Row {
    const row = this.sql.exec<Row>("select * from native_apps where id=?", id).toArray()[0];
    if (!row) throw new Error("App not found");
    return row;
  }
  private intent(id: string, desired: string) {
    this.sql.exec("update native_apps set desired=?,status='deploying',stage='pending',endpoint=null,operation=?,attempts=0,error=null,updated_at=? where id=?", desired, crypto.randomUUID(), new Date().toISOString(), id);
  }
  restore(input: Selection & { revision_id: string }) {
    const row = this.row(input);
    return this.serial(row.id, async () => {
      const current = this.row(input), saved = this.revision(row.id, input.revision_id);
      // Restore source against the complete current ledger, including retired namespaces.
      return this.prepare(current, { source: saved.source, manifest: saved.manifest, project: saved.project ?? emptyProject() });
    });
  }
  reconcile(input: Selection) {
    const row = this.row(input);
    return this.serial(row.id, async () => {
      const current = this.row(input);
      if (!current.desired) throw new Error("App has no compiled revision to deploy");
      this.intent(row.id, current.desired);
      return this.activate(row.id);
    });
  }
  secrets(input: Selection & { secrets?: Record<string, string | null> }) {
    const row = this.row(input);
    return this.serial(row.id, async () => {
      const current = this.row(input), values = JSON.parse(current.secrets) as Record<string, string>;
      if (input.secrets === undefined) return { names: Object.keys(values).sort() };
      for (const [key, value] of Object.entries(input.secrets)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || value !== null && (typeof value !== "string" || bytes(value) > 4096)) throw new Error("Invalid app secret");
        if (value === null) delete values[key]; else values[key] = value;
      }
      if (Object.keys(values).length > 32 || bytes(JSON.stringify(values)) > 32768) throw new Error("App secrets exceed 32 keys or 32 KiB");
      this.sql.exec("update native_apps set secrets=? where id=?", JSON.stringify(values), row.id);
      let result: unknown;
      if (current.desired) { this.intent(row.id, current.desired); result = await this.activate(row.id); }
      return { names: Object.keys(values).sort(), deployment: result };
    });
  }
  move(input: Selection & { destination: string }) {
    const row = this.row(input);
    return this.serial(row.id, async () => {
      this.row(input);
      if (this.sql.exec("select id from native_apps where owner=? and workspace=? and name=?", input.destination, input.workspace, input.name).toArray().length) throw new Error("Destination app name is already in use");
      this.sql.exec("update native_apps set owner=? where id=?", input.destination, row.id);
      return { ok: true, name: row.name, workspace: row.workspace };
    });
  }
  private async activate(id: string) {
    const row = this.byId(id), revision = this.revision(id, row.desired!);
    const state = JSON.parse(row.provider_state) as ProviderState;
    const stored = JSON.parse(row.secrets) as Record<string, string>, secrets: Record<string, string> = {};
    this.sql.exec("update native_apps set attempts=attempts+1 where id=?", id);
    // A process crash at any external call leaves desired state plus a wakeup.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      for (const name of revision.manifest.secrets) {
        if (typeof stored[name] !== "string") throw new Error(`Missing declared app secret: ${name}`);
        secrets[name] = stored[name]!;
      }
      const deployment: NativeDeployment = { app: id, revision, resources: JSON.parse(row.resources) as ResourceLedger, secrets };
      let result: ProviderResult;
      if (row.provider === "cloudflare") {
        result = await new CloudflareNativeProvider(this.env).reconcile(deployment, state, async (stage, providerState) => {
          this.sql.exec("update native_apps set stage=?,provider_state=?,updated_at=? where id=?", stage, JSON.stringify(providerState), new Date().toISOString(), id);
        });
      } else {
        const endpoint = this.operatorUrl();
        if (state.operatorOrigin !== endpoint.origin) throw new Error("App operator origin changed; restore its configured operator before reconciling");
        this.sql.exec("update native_apps set stage='operator-reconcile' where id=?", id);
        const response = await fetch(new URL("deploy", endpoint), { method: "POST", headers: { Authorization: `Bearer ${this.env.NATIVE_CELLD_OPERATOR_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(deployment), signal: AbortSignal.timeout(120_000), redirect: "manual" });
        if (!response.ok) throw new Error(`celld operator deployment failed (${response.status})`);
        result = await response.json() as ProviderResult;
        // Use the configured trusted operator origin, never an arbitrary returned URL.
        if (result.revision !== revision.id || new URL(result.endpoint).origin !== endpoint.origin) throw new Error("celld operator returned an invalid deployment result");
        result.endpoint = new URL(`apps/${id}/`, endpoint).href;
      }
      this.sql.exec("update native_apps set active=?,endpoint=?,status='active',stage='active',error=null,updated_at=? where id=?", result.revision, result.endpoint, new Date().toISOString(), id);
      return { ok: true, ...this.summary(this.byId(id)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native app deployment failed";
      this.sql.exec("update native_apps set status='recovery-required',error=?,endpoint=null,updated_at=? where id=?", message, new Date().toISOString(), id);
      return { ok: false, ...this.summary(this.byId(id)) };
    }
  }
  private operatorUrl() {
    if (!nativeProviders(this.env).includes("celld-local")) throw new Error("Trusted celld native provider is not configured");
    const endpoint = new URL(this.env.NATIVE_CELLD_OPERATOR_URL!);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("Operator URL must be HTTPS or loopback HTTP, without a path or credentials");
    return endpoint;
  }
  async alarm() {
    const rows = this.sql.exec<Row>("select * from native_apps where status='deploying' or (status='recovery-required' and attempts<3)").toArray();
    for (const row of rows) await this.serial(row.id, async () => {
      const current = this.byId(row.id);
      if (current.status === "active" || !current.desired || current.attempts >= 3) return;
      this.sql.exec("update native_apps set status='deploying' where id=?", row.id);
      await this.activate(row.id);
    });
  }
  async fetch(request: Request): Promise<Response> {
    const encoded = request.headers.get("x-artifacts-app-selection");
    if (!encoded) return new Response("Not found", { status: 404 });
    const row = this.row(JSON.parse(encoded) as Selection);
    if (row.status !== "active" || !row.endpoint) return new Response("App deployment requires reconciliation", { status: 503 });
    const headers = new Headers(request.headers);
    for (const key of ["x-artifacts-app-selection", "x-artifacts-gateway-token", "x-artifacts-target-url", "authorization", "cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) headers.delete(key);
    const target = new URL(request.url), endpoint = new URL(row.endpoint);
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + target.pathname;
    endpoint.search = target.search;
    headers.set("x-artifacts-target-url", request.url);
    if (row.provider === "cloudflare") {
      headers.set("x-artifacts-gateway-token", (JSON.parse(row.provider_state) as CloudflareProviderState).gatewayToken);
    } else headers.set("authorization", `Bearer ${this.env.NATIVE_CELLD_OPERATOR_TOKEN}`);
    const response = await fetch(endpoint, { method: request.method, headers, body: request.body, redirect: "manual" });
    if (response.status === 101) {
      const output = new Headers(response.headers); output.delete("set-cookie");
      return new Response(null, { status: 101, headers: output, webSocket: response.webSocket });
    }
    return artifactApiResponse(response, request.method);
  }
}
