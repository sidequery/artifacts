import { ProjectStorage } from "./project-storage";
import { DurableObject } from "cloudflare:workers";
import { sha256, MAX_SOURCE_BYTES, type ArtifactEdit } from "./library";

import { emptyProject, normalizeProject, projectSourceHash, type ArtifactProject } from "./project";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || bytes(value) > max) throw new Error(`invalid ${label}`);
  return value.trim();
}
function key(input: { workspace: string; name: string }) {
  const workspace = text(input.workspace, "workspace");
  const name = text(input.name, "script name", 255).replace(/\.script\.ts$/, "");
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error("invalid script name");
  return { workspace, name };
}
function source(value: unknown): string {
  if (typeof value !== "string" || bytes(value) > MAX_SOURCE_BYTES) throw new Error("script source must be a string of at most 256 KiB");
  return value;
}
function page(input: {offset?: number; limit?: number}) {
  const offset = input.offset ?? 0, limit = input.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid pagination");
  return {offset, limit};
}
type Row = { workspace: string; name: string; source: string; project: string; source_hash: string; updated_at: string; active_code: string | null; active_hash: string | null; secrets: string };
type VersionRow = { id: string; workspace: string; name: string; revision: number; source: string; project: string; source_hash: string; created_at: string; reason: string; restored_from: string | null };
export class ScriptLibrary extends DurableObject<unknown> {
  private sql: SqlStorage;
  private readonly projectStorage: ProjectStorage;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.sql = state.storage.sql;
    this.projectStorage = new ProjectStorage(this.sql);
    this.sql.exec(`create table if not exists scripts (workspace text not null,name text not null,source text not null,source_hash text not null,updated_at text not null,active_code text,active_hash text,secrets text not null default '{}',primary key(workspace,name))`);
    this.sql.exec(`create table if not exists script_versions (id text primary key,workspace text not null,name text not null,revision integer not null,source text not null,source_hash text not null,created_at text not null,reason text not null,restored_from text,unique(workspace,name,revision))`);
    this.sql.exec("create table if not exists script_remix_origins (workspace text not null,name text not null,source_name text not null,source_version_id text not null,primary key(workspace,name))");
    this.sql.exec(`create table if not exists compiled_scripts (workspace text not null,name text not null,hash text not null,code text not null,primary key(workspace,name,hash))`);
    for (const table of ["scripts", "script_versions"]) {
      if (!this.sql.exec<{name: string}>(`pragma table_info(${table})`).toArray().some(column => column.name === "project")) {
        this.sql.exec(`alter table ${table} add column project text not null default '{"files":{},"dependencies":{},"lock":{}}'`);
      }
    }
  }
  private row(input: {workspace: string; name: string}): Row {
    const {workspace,name} = key(input);
    const row = this.sql.exec<Row>("select * from scripts where workspace=? and name=?",workspace,name).toArray()[0];
    if (!row) throw new Error("script not found");
    return row;
  }
  private save(input: {workspace: string; name: string; source: string; project?: ArtifactProject}, reason: string, restoredFrom: string | null = null) {
    const {workspace,name} = key(input), code = source(input.source), updated_at = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const current = this.sql.exec<Row>("select * from scripts where workspace=? and name=?",workspace,name).toArray()[0];
      const project = input.project === undefined ? (current ? this.projectStorage.read(current.project) : emptyProject()) : normalizeProject(input.project);
      const source_hash = projectSourceHash(code, project);
      this.sql.exec(`insert into scripts(workspace,name,source,source_hash,updated_at,project) values(?,?,?,?,?,?) on conflict(workspace,name) do update set source=excluded.source,source_hash=excluded.source_hash,updated_at=excluded.updated_at,project=excluded.project`,workspace,name,code,source_hash,updated_at,this.projectStorage.encode(project));
      const previous = this.sql.exec<{revision: number; source_hash: string}>("select revision,source_hash from script_versions where workspace=? and name=? order by revision desc limit 1",workspace,name).toArray()[0];
      if (previous?.source_hash !== source_hash || reason === "restore") this.sql.exec("insert into script_versions(id,workspace,name,revision,source,source_hash,created_at,reason,restored_from,project) values(?,?,?,?,?,?,?,?,?,?)",crypto.randomUUID(),workspace,name,(previous?.revision ?? 0)+1,code,source_hash,updated_at,reason,restoredFrom,this.projectStorage.encode(project));
      return {ok:true,workspace,name,path:`${workspace}/${name}.script.ts`,source:code,project,source_hash,updated_at};
    });
  }
  writeDraft(input: {workspace: string; name: string; source: string; project?: ArtifactProject}) { return this.save(input,"edit"); }
  remix(input: {workspace: string; name?: string; version_id?: string; new_name: string}) {
    const {workspace,name} = key({workspace:input.workspace,name:input.new_name});
    if (Boolean(input.name) === Boolean(input.version_id)) throw new Error("provide name or version_id, but not both");
    return this.ctx.storage.transactionSync(() => {
      if (this.sql.exec("select name from scripts where workspace=? and name=? union all select name from script_versions where workspace=? and name=?",workspace,name,workspace,name).toArray().length) throw new Error("Destination script already exists; choose a new name");
      const origin = input.version_id ? this.version({workspace,id:input.version_id}) : (() => {
        const draft = this.row({workspace,name:input.name!});
        const latest = this.sql.exec<VersionRow>("select * from script_versions where workspace=? and name=? order by revision desc limit 1",workspace,draft.name).toArray()[0];
        if (!latest || latest.source_hash !== draft.source_hash) throw new Error("Script draft has no matching revision");
        return {...latest,project:this.projectStorage.read(latest.project)};
      })();
      const result = this.save({workspace,name,source:origin.source,project:origin.project},"remix");
      this.sql.exec("insert into script_remix_origins values(?,?,?,?)",workspace,name,origin.name,origin.id);
      return {...result,remixed:true,origin:{source_name:origin.name,source_version_id:origin.id}};
    });
  }
  listDrafts(input: {workspace?: string; offset?: number; limit?: number} = {}) {
    const {offset,limit} = page(input), workspace = input.workspace === undefined ? null : text(input.workspace,"workspace");
    return this.sql.exec<{workspace: string; name: string; source_hash: string; updated_at: string; active_hash: string | null}>("select workspace,name,source_hash,updated_at,active_hash from scripts where (? is null or workspace=?) order by workspace,name limit ? offset ?",workspace,workspace,limit,offset).toArray().map(row=>({...row,id:row.name,path:`${row.workspace}/${row.name}.script.ts`,kind:"script" as const}));
  }
  readRange(input: {workspace: string; name: string; file?: string; start_line?: number; end_line?: number}) {
    const row = this.row(input), project = this.projectStorage.read(row.project);
    if (input.file !== undefined && !Object.hasOwn(project.files,input.file)) throw new Error("project file not found");
    const selected = input.file === undefined ? row.source : project.files[input.file]!;
    const lines = selected.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
    const start = input.start_line ?? 1, end = input.end_line ?? start+199;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<1 || end<start || start>lines.length) throw new Error("invalid line range");
    const actualEnd = Math.min(end,lines.length);
    return {workspace:row.workspace,name:row.name,path:input.file ?? `${row.workspace}/${row.name}.script.ts`,file:input.file,project,source:lines.slice(start-1,actualEnd).join(""),source_hash:input.file === undefined ? row.source_hash : sha256(selected),total_lines:lines.length,start_line:start,end_line:actualEnd,next_line:actualEnd<lines.length?actualEnd+1:null};
  }
  editDraft(input: {workspace: string; name: string; file?: string; edits: ArtifactEdit[]; expected_hash?: string}) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.row(input), project = this.projectStorage.read(row.project);
      if (input.file !== undefined && !Object.hasOwn(project.files,input.file)) throw new Error("project file not found");
      const selected = input.file === undefined ? row.source : project.files[input.file]!;
      if (input.expected_hash !== undefined && input.expected_hash !== (input.file === undefined ? row.source_hash : sha256(selected))) throw new Error("script changed since read; read it again before editing");
      if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length>100) throw new Error("edits must contain 1 to 100 edits");
      let code = selected;
      for (const edit of input.edits) {
        if (!edit || typeof edit.old_text!=="string" || !edit.old_text || typeof edit.new_text!=="string") throw new Error("invalid edit");
        const at = code.indexOf(edit.old_text);
        if (at<0) throw new Error("old_text not found; no changes written");
        if (code.indexOf(edit.old_text,at+1)!==-1) throw new Error("old_text is ambiguous; no changes written");
        code = code.slice(0,at)+edit.new_text+code.slice(at+edit.old_text.length);
        source(code);
      }
      const result = input.file === undefined
        ? this.save({workspace:row.workspace,name:row.name,source:code,project},"edit")
        : this.save({workspace:row.workspace,name:row.name,source:row.source,project:{...project,files:{...project.files,[input.file]:code}}},"edit");
      return {...result,file:input.file,changed:code!==selected,applied:true,edits_applied:input.edits.length};
    });
  }
  activate(input: {workspace: string; name: string; source_hash: string; code: string}) {
    const row = this.row(input);
    if (row.source_hash!==input.source_hash) throw new Error("script changed during validation; retry");
    if (typeof input.code!=="string" || !input.code || bytes(input.code)>2*1024*1024) throw new Error("invalid compiled script");
    const hash=sha256(input.code);
    this.ctx.storage.transactionSync(()=>{
      this.sql.exec("insert into compiled_scripts(workspace,name,hash,code) values(?,?,?,?) on conflict(workspace,name,hash) do nothing",row.workspace,row.name,hash,input.code);
      this.sql.exec("update scripts set active_code=?,active_hash=? where workspace=? and name=?",input.code,hash,row.workspace,row.name);
    });
    return {ok:true,source_hash:row.source_hash,hash};
  }
  /** Internal execution lookup. Never return this response through management APIs. */
  active(input: {workspace: string; name: string; hash?: string}) {
    const row = this.row(input);
    if (input.hash!==undefined) {
      const compiled=this.sql.exec<{code: string; hash: string}>("select code,hash from compiled_scripts where workspace=? and name=? and hash=?",row.workspace,row.name,input.hash).toArray()[0];
      if (!compiled) throw new Error("validated script version not found");
      return {...compiled,secrets:JSON.parse(row.secrets) as Record<string,string>};
    }
    if (!row.active_code || !row.active_hash) throw new Error("script has no validated version");
    return {code:row.active_code,hash:row.active_hash,secrets:JSON.parse(row.secrets) as Record<string,string>};
  }
  secretNames(input: {workspace: string; name: string}) { return Object.keys(JSON.parse(this.row(input).secrets) as object).sort(); }
  /** Internal runtime configuration; never expose secret values through management responses. */
  executionSecrets(input: {workspace: string; name: string}) { return JSON.parse(this.row(input).secrets) as Record<string,string>; }
  setSecret(input: {workspace: string; name: string; key: string; value: string | null}) {
    const row = this.row(input);
    if (typeof input.key!=="string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.key) || ["__proto__","constructor","prototype"].includes(input.key)) throw new Error("invalid secret key");
    if (input.value!==null && (typeof input.value!=="string" || bytes(input.value)>4096)) throw new Error("secret exceeds 4 KiB");
    const secrets = JSON.parse(row.secrets) as Record<string,string>;
    if (input.value===null) delete secrets[input.key]; else secrets[input.key]=input.value;
    const encoded = JSON.stringify(secrets);
    if (Object.keys(secrets).length>32 || bytes(encoded)>32768) throw new Error("script secrets exceed 32 keys or 32 KiB");
    this.sql.exec("update scripts set secrets=? where workspace=? and name=?",encoded,row.workspace,row.name);
    return {ok:true,names:Object.keys(secrets).sort()};
  }
  history(input: {workspace?: string; name?: string; offset?: number; limit?: number} = {}) {
    const {offset,limit}=page(input), workspace=input.workspace===undefined?null:text(input.workspace,"workspace"), name=input.name===undefined?null:key({workspace:workspace??"default",name:input.name}).name;
    return this.sql.exec<Omit<VersionRow,"source">>("select id,workspace,name,revision,source_hash,created_at,reason,restored_from from script_versions where (? is null or workspace=?) and (? is null or name=?) order by created_at desc,rowid desc limit ? offset ?",workspace,workspace,name,name,limit,offset).toArray().map(row=>({...row,version_id:row.id}));
  }
  version(input: {workspace: string; id: string}) {
    const workspace=text(input.workspace,"workspace"), id=text(input.id,"version id");
    const row=this.sql.exec<VersionRow>("select * from script_versions where workspace=? and id=?",workspace,id).toArray()[0];
    if (!row) throw new Error("version not found in this workspace");
    return {...row,project:this.projectStorage.read(row.project),origin:this.sql.exec<{source_name: string;source_version_id: string}>("select source_name,source_version_id from script_remix_origins where workspace=? and name=?",workspace,row.name).toArray()[0] ?? null};
  }
  restore(input: {workspace: string; id: string}) {
    const version=this.version(input);
    return {...this.save(version,"restore",version.id),restored:true};
  }
}
