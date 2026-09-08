import type { ScriptSchedule } from "./script-backend";
import { resolveProject } from "./project";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type { ArtifactEdit } from "./library";
import type { ArtifactService } from "./artifact-service";
import type { LinkUpdate } from "./links";
import type { ArtifactHttpRequest } from "../src/httpTypes";
import { formatArtifactCheck } from "../src/diagnostics";
import { nativeRequest } from "./backend";
import { compileScriptSource } from "./compiler";
import { scriptResponse } from "./script-service-http";
import { HOSTED_SCRIPT_GUIDE } from "./script-guide";

export class CloudScriptService {
  constructor(private readonly artifacts: ArtifactService) {}

  async readSource(selection: { name?: string; version_id?: string }) {
    const scripts = this.artifacts.requireHosted().scripts;
    if (selection.version_id) {
      const version = await scripts.version({ workspace: this.artifacts.workspace, id: selection.version_id });
      if (selection.name && version.name !== this.artifacts.target("script", selection.name).name) throw new Error("Version does not belong to this script");
      return { ...version, path: `${this.artifacts.workspace}/${version.name}.script.ts` };
    }
    if (!selection.name) throw new Error("name or version_id is required");
    return scripts.readRange({ workspace: this.artifacts.workspace, name: selection.name, end_line: Number.MAX_SAFE_INTEGER });
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const hosted = this.artifacts.requireHosted(), scripts = hosted.scripts;
    const name = args.name as string, input = { workspace: this.artifacts.workspace, name };
    const offset = args.offset as number | undefined ?? 0;
    switch (tool) {
      case "script_guide": return { content: [{ type: "text", text: HOSTED_SCRIPT_GUIDE }] };
      case "script_list": {
        const drafts = await scripts.listDrafts({ workspace: this.artifacts.workspace, offset });
        const entries = await Promise.all(drafts.map(async draft => ({ ...draft, ...await this.artifacts.linkDetails(this.artifacts.target("script", draft.name)) })));
        return text({ scripts: entries, next_offset: entries.length === 100 ? offset + 100 : null });
      }
      case "script_read": {
        if (!args.version_id) return text(await scripts.readRange({ ...input, file: args.file as string | undefined, start_line: args.start_line as number | undefined, end_line: args.end_line as number | undefined }));
        const version = await this.readSource({ name, version_id: args.version_id as string });
        const selected = args.file === undefined ? version.source : Object.hasOwn(version.project.files, args.file as string) ? version.project.files[args.file as string] : undefined;
        if (selected === undefined) throw new Error("project file not found");
        const lines = selected.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
        const start = args.start_line as number | undefined ?? 1, end = args.end_line as number | undefined ?? start + 199;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || start > lines.length) throw new Error("invalid line range");
        const actualEnd = Math.min(end, lines.length);
        return text({ ...version, ...(args.file === undefined ? {} : { file: args.file, path: args.file, source_hash: createHash("sha256").update(selected).digest("hex") }), source: lines.slice(start - 1, actualEnd).join(""), start_line: start, end_line: actualEnd, total_lines: lines.length, next_line: actualEnd < lines.length ? actualEnd + 1 : null });
      }
      case "script_history": {
        const versions = await scripts.history({ workspace: this.artifacts.workspace, name, offset });
        return text({ versions, next_offset: versions.length === 100 ? offset + 100 : null });
      }
      case "script_version": return text(await scripts.version({ workspace: this.artifacts.workspace, id: args.version_id as string }));
      case "script_schedule": {
        const target=this.artifacts.target("script",name);
        const backend=hosted.scriptBackends.getByName(JSON.stringify([this.artifacts.libraryKey,this.artifacts.workspace,target.name]));
        if (args.action==="set") {
          const link=await hosted.links.find(target);
          if (!link?.script_hash) throw new Error("Script has no validated URL revision");
        }
        return text({schedule:await backend.schedule({action:args.action as "get"|"set"|"pause"|"resume"|"run_now"|undefined,interval_seconds:args.interval_seconds as number|undefined,cron:args.cron as string|undefined,timezone:args.timezone as string|undefined,request:args.request as ScriptSchedule["request"]|undefined,...(args.action==="set"?{identity:{libraryKey:this.artifacts.libraryKey,workspace:this.artifacts.workspace,name:target.name,origin:hosted.origin}}:{})})});
      }
      case "script_runs": return text({runs:await hosted.scriptBackends.getByName(JSON.stringify([this.artifacts.libraryKey,this.artifacts.workspace,this.artifacts.target("script",name).name])).runs({limit:args.limit as number|undefined})});
      case "script_logs": return text({ logs: await hosted.scriptBackends.getByName(JSON.stringify([this.artifacts.libraryKey, this.artifacts.workspace, this.artifacts.target("script", name).name])).logs({ limit: args.limit as number | undefined, run_id: args.run_id as string | undefined }) });
      case "script_secrets": {
        if (args.secrets !== undefined) {
          if (!args.secrets || typeof args.secrets !== "object" || Array.isArray(args.secrets)) throw new Error("secrets must be an object");
          for (const [key, value] of Object.entries(args.secrets)) await scripts.setSecret({ ...input, key, value: value as string | null });
        }
        return text({ ok: true, names: await scripts.secretNames(input) });
      }
      case "script_run": {
        const link = await hosted.links.find(this.artifacts.target("script", name));
        if (!link?.script_hash) throw new Error("Script has no validated URL revision");
        const active = await scripts.active({ ...input, hash: link.script_hash });
        const incoming = nativeRequest(args.request as ArtifactHttpRequest);
        const request = new Request(new URL(new URL(incoming.url).pathname + new URL(incoming.url).search, hosted.origin), incoming);
        const response = await hosted.scriptBackends.getByName(JSON.stringify([this.artifacts.libraryKey, this.artifacts.workspace, this.artifacts.target("script", name).name])).request({ ...active, request, trigger: "manual" });
        const envelope = await scriptResponse(response, incoming.method);
        return { ...text({ status: envelope.status, ...(link ? { url: `${hosted.publicOrigin ?? hosted.origin}/${link.slug}` } : {}) }), structuredContent: { response: envelope } };
      }
      case "script_remix": case "script_write": case "script_edit": case "script_restore": {
        const target = this.artifacts.target("script", tool === "script_remix" ? args.new_name as string : name);
        // Read pending intent only after taking this operation's generation.
        // A concurrent explicit access change then either precedes this read or
        // supersedes this generation; it cannot be undone by stale metadata.
        let generation = tool === "script_remix" ? undefined : await hosted.links.begin(target);
        const settings: LinkUpdate = await hosted.links.draft(target);
        if (tool === "script_remix") { settings.slug = args.slug as string | undefined ?? target.name; settings.access = "private"; }
        if (tool === "script_write") {
          const previous = await hosted.links.find(target);
          settings.slug = args.slug as string | undefined ?? settings.slug ?? previous?.slug ?? target.name;
          if (args.access !== undefined) settings.access = args.access as "private" | "public";
        }
        if (settings.slug !== undefined) await hosted.links.check(target, settings.slug);
        if (tool === "script_restore") {
          const version = await scripts.version({ workspace: this.artifacts.workspace, id: args.version_id as string });
          if (version.name !== target.name) throw new Error("Version does not belong to this script");
        }
        const destination = {...input,name:target.name};
        const previous = tool === "script_write" && args.project !== undefined ? await scripts.readRange(input).catch(error => { if (error instanceof Error && error.message.includes("script not found")) return undefined; throw error; }) : undefined;
        const project = tool === "script_write" && args.project !== undefined ? await resolveProject(args.project, previous?.project) : undefined;
        const mutation = tool === "script_remix" ? await scripts.remix({workspace:this.artifacts.workspace,name:args.name as string | undefined,version_id:args.version_id as string | undefined,new_name:args.new_name as string}) : tool === "script_write" ? await scripts.writeDraft({ ...input, source: args.contents as string, project })
          : tool === "script_edit" ? await scripts.editDraft({ ...input, file: args.file as string | undefined, edits: args.edits as ArtifactEdit[], expected_hash: args.expected_hash as string | undefined })
          : await scripts.restore({ workspace: this.artifacts.workspace, id: args.version_id as string });
        generation ??= await hosted.links.begin(target);
        await hosted.links.stage(target, generation, settings);
        const compiled = await compileScriptSource(mutation.source, mutation.project);
        if (compiled.ok && compiled.js) {
          const secrets = await scripts.executionSecrets(destination);
          const backend = hosted.scriptBackends.getByName(JSON.stringify([this.artifacts.libraryKey, this.artifacts.workspace, target.name]));
          const validation = await backend.validate({ code: compiled.js, hash: createHash("sha256").update(compiled.js).digest("hex"), secrets });
          if (validation.ok) {
            try {
              const activated = await scripts.activate({ ...destination, source_hash: mutation.source_hash, code: compiled.js });
              const link = await hosted.links.commit(target, generation, { ...settings, script_hash: activated.hash });
              if (!link) {
                const { source, project: snapshotProject, ...summary } = mutation;
                const superseded = { ...summary, ...await this.artifacts.linkDetails(target), applied: true, ok: false, superseded: true, error: "A newer update superseded this URL activation" };
                return { ...text(superseded, true), structuredContent: superseded };
              }
            } catch (error) {
              const { source, project: snapshotProject, ...summary } = mutation;
              const message = error instanceof Error ? error.message : "Script URL activation failed";
              const failed = { ...summary, ...await this.artifacts.linkDetails(target), applied: true, ok: false, ...(message.includes("changed during validation") ? { superseded: true } : {}), error: message };
              return { ...text(failed, true), structuredContent: failed };
            }
          } else {
            compiled.ok = false;
            compiled.diagnostics.push({ severity: "error", message: "Script module could not initialize" });
          }
        }
        const { source, project: snapshotProject, ...summary } = mutation;
        const payload = { ...summary, ...await this.artifacts.linkDetails(target), applied: true, ok: compiled.ok, check: formatArtifactCheck(compiled.diagnostics), diagnostics: compiled.diagnostics };
        return { ...text(payload, !compiled.ok), structuredContent: payload };
      }
      default: throw new Error("Unknown script tool");
    }
  }
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}
