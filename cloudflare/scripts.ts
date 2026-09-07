import { DurableObject } from "cloudflare:workers";
import { sha256, MAX_SOURCE_BYTES, type CanvasEdit } from "./library";

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
type Row = { workspace: string; name: string; source: string; source_hash: string; updated_at: string; active_code: string | null; active_hash: string | null; secrets: string };
type VersionRow = { id: string; workspace: string; name: string; revision: number; source: string; source_hash: string; created_at: string; reason: string; restored_from: string | null };
export class ScriptLibrary extends DurableObject<unknown> {
  private sql: SqlStorage;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`create table if not exists scripts (workspace text not null,name text not null,source text not null,source_hash text not null,updated_at text not null,active_code text,active_hash text,secrets text not null default '{}',primary key(workspace,name))`);
    this.sql.exec(`create table if not exists script_versions (id text primary key,workspace text not null,name text not null,revision integer not null,source text not null,source_hash text not null,created_at text not null,reason text not null,restored_from text,unique(workspace,name,revision))`);
    this.sql.exec(`create table if not exists compiled_scripts (workspace text not null,name text not null,hash text not null,code text not null,primary key(workspace,name,hash))`);
  }
  private row(input: {workspace: string; name: string}): Row {
    const {workspace,name} = key(input);
    const row = this.sql.exec<Row>("select * from scripts where workspace=? and name=?",workspace,name).toArray()[0];
    if (!row) throw new Error("script not found");
    return row;
  }
  private save(input: {workspace: string; name: string; source: string}, reason: string, restoredFrom: string | null = null) {
    const {workspace,name} = key(input), code = source(input.source), source_hash = sha256(code), updated_at = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(`insert into scripts(workspace,name,source,source_hash,updated_at) values(?,?,?,?,?) on conflict(workspace,name) do update set source=excluded.source,source_hash=excluded.source_hash,updated_at=excluded.updated_at`,workspace,name,code,source_hash,updated_at);
      const previous = this.sql.exec<{revision: number; source_hash: string}>("select revision,source_hash from script_versions where workspace=? and name=? order by revision desc limit 1",workspace,name).toArray()[0];
      if (previous?.source_hash !== source_hash || reason === "restore") this.sql.exec("insert into script_versions values(?,?,?,?,?,?,?,?,?)",crypto.randomUUID(),workspace,name,(previous?.revision ?? 0)+1,code,source_hash,updated_at,reason,restoredFrom);
      return {ok:true,workspace,name,path:`${workspace}/${name}.script.ts`,source:code,source_hash,updated_at};
    });
  }
  writeDraft(input: {workspace: string; name: string; source: string}) { return this.save(input,"edit"); }
  listDrafts(input: {workspace?: string; offset?: number; limit?: number} = {}) {
    const {offset,limit} = page(input), workspace = input.workspace === undefined ? null : text(input.workspace,"workspace");
    return this.sql.exec<{workspace: string; name: string; source_hash: string; updated_at: string; active_hash: string | null}>("select workspace,name,source_hash,updated_at,active_hash from scripts where (? is null or workspace=?) order by workspace,name limit ? offset ?",workspace,workspace,limit,offset).toArray().map(row=>({...row,id:row.name,path:`${row.workspace}/${row.name}.script.ts`,kind:"script" as const}));
  }
  readRange(input: {workspace: string; name: string; start_line?: number; end_line?: number}) {
    const row = this.row(input), lines = row.source.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
    const start = input.start_line ?? 1, end = input.end_line ?? start+199;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<1 || end<start || start>lines.length) throw new Error("invalid line range");
    const actualEnd = Math.min(end,lines.length);
    return {workspace:row.workspace,name:row.name,path:`${row.workspace}/${row.name}.script.ts`,source:lines.slice(start-1,actualEnd).join(""),source_hash:row.source_hash,total_lines:lines.length,start_line:start,end_line:actualEnd,next_line:actualEnd<lines.length?actualEnd+1:null};
  }
  editDraft(input: {workspace: string; name: string; edits: CanvasEdit[]; expected_hash?: string}) {
    const row = this.row(input);
    if (input.expected_hash !== undefined && input.expected_hash !== row.source_hash) throw new Error("script changed since read; read it again before editing");
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length>100) throw new Error("edits must contain 1 to 100 edits");
    let code = row.source;
    for (const edit of input.edits) {
      if (!edit || typeof edit.old_text!=="string" || !edit.old_text || typeof edit.new_text!=="string") throw new Error("invalid edit");
      const at = code.indexOf(edit.old_text);
      if (at<0) throw new Error("old_text not found; no changes written");
      if (code.indexOf(edit.old_text,at+1)!==-1) throw new Error("old_text is ambiguous; no changes written");
      code = code.slice(0,at)+edit.new_text+code.slice(at+edit.old_text.length);
      source(code);
    }
    return {...this.save({...row,source:code},"edit"),changed:code!==row.source,applied:true,edits_applied:input.edits.length};
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
    return row;
  }
  restore(input: {workspace: string; id: string}) {
    const version=this.version(input);
    return {...this.save(version,"restore",version.id),restored:true};
  }
}
