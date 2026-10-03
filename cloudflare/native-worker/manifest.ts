import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";

type Binding = { type: "kv" | "r2" | "d1" | "queue"; resource: string }
  | { type: "durable-object"; resource: string; class_name: string };
export type AppManifest = {
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  vars: Record<string, string>;
  secrets: string[];
  bindings: Record<string, Binding>;
  triggers: { crons: string[]; queues: string[] };
};
export type ResourceLedger = Record<string, { type: Binding["type"]; id: string }>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  if (new Set(value).size !== value.length) throw new Error(`Duplicate ${label}`);
  return value;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
    || ["__proto__", "constructor", "prototype"].includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** A deliberately small sidecar contract. Unknown Wrangler fields fail closed. */
export function parseManifest(value: unknown): AppManifest {
  const input = object(value, "manifest");
  keys(input, ["main", "compatibility_date", "compatibility_flags", "vars", "secrets", "bindings", "triggers"], "manifest");
  if (typeof input.main !== "string" || !/^[A-Za-z0-9_./-]+\.[cm]?[jt]s$/.test(input.main)
    || input.main.startsWith("/") || input.main.split("/").includes("..")) throw new Error("main must be a relative JS/TS path inside the project");
  const date = input.compatibility_date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Invalid compatibility_date");
  const flags = strings(input.compatibility_flags ?? [], "compatibility_flags");
  if (flags.length > 32 || flags.some(flag => !/^[a-z0-9_]{1,100}$/.test(flag))) throw new Error("Invalid compatibility flags");
  if (flags.includes("experimental")) throw new Error("Experimental compatibility flags are not supported");
  const vars = object(input.vars ?? {}, "vars");
  for (const [name, value] of Object.entries(vars)) {
    identifier(name, "variable name");
    if (typeof value !== "string") throw new Error("vars values must be strings");
  }
  const secrets = strings(input.secrets ?? [], "secrets");
  for (const name of secrets) identifier(name, "secret name");
  const bindings: Record<string, Binding> = Object.create(null);
  const resources = new Set<string>();
  const exports = new Set<string>();
  for (const [name, value] of Object.entries(object(input.bindings ?? {}, "bindings"))) {
    identifier(name, "binding name");
    const binding = object(value, "binding");
    const type = binding.type;
    if (!["kv", "r2", "d1", "queue", "durable-object"].includes(String(type))) throw new Error(`Unsupported binding type: ${type}`);
    keys(binding, type === "durable-object" ? ["type", "resource", "class_name"] : ["type", "resource"], "binding");
    const resource = identifier(binding.resource, "resource name");
    if (resources.has(resource)) throw new Error(`Duplicate resource: ${resource}`);
    resources.add(resource);
    if (type === "durable-object") {
      const class_name = identifier(binding.class_name, "DO class name");
      if (class_name === "default" || exports.has(class_name)) throw new Error("DO class must have one resource and a named export");
      exports.add(class_name);
      bindings[name] = { type, resource, class_name };
    } else bindings[name] = { type: type as "kv" | "r2" | "d1" | "queue", resource };
  }
  const names = [...Object.keys(vars), ...secrets, ...Object.keys(bindings)];
  if (Object.keys(bindings).length > 32 || Object.keys(vars).length > 32 || secrets.length > 32
    || new TextEncoder().encode(JSON.stringify(vars)).byteLength > 32768) throw new Error("App manifest binding limits exceeded");
  if (new Set(names).size !== names.length) throw new Error("Binding, variable and secret names must not overlap");
  const triggers = object(input.triggers ?? {}, "triggers");
  keys(triggers, ["crons", "queues"], "triggers");
  const crons = strings(triggers.crons ?? [], "crons");
  if (crons.length > 32 || crons.some(cron => cron.length > 256)) throw new Error("Too many or oversized cron triggers");
  for (const cron of crons) {
    if (cron.trim().split(/\s+/).length !== 5) throw new Error("crons must use five fields");
    CronExpressionParser.parse(cron);
  }
  const queues = strings(triggers.queues ?? [], "queues");
  for (const resource of queues) if (!Object.values(bindings).some(binding => binding.type === "queue" && binding.resource === resource)) {
    throw new Error(`Queue consumer has no app-owned queue: ${resource}`);
  }
  return structuredClone({ main: input.main, compatibility_date: date, compatibility_flags: flags, vars: vars as Record<string, string>, secrets, bindings, triggers: { crons, queues } });
}

export function appScope(owner: string, app: string) {
  if (!owner || !app) throw new Error("Physical owner and app identity are required");
  return createHash("sha256").update(JSON.stringify([owner, app])).digest("hex");
}

/** Identities depend on physical ownership and a stable resource name, never code or export names. */
export function planResources(scope: string, manifest: AppManifest, previous: ResourceLedger): ResourceLedger {
  const ledger = structuredClone(previous);
  for (const binding of Object.values(manifest.bindings)) {
    const existing = ledger[binding.resource];
    if (existing && existing.type !== binding.type) throw new Error(`Resource ${binding.resource} cannot change type; use a new resource name`);
    ledger[binding.resource] ??= { type: binding.type, id: createHash("sha256").update(JSON.stringify([scope, binding.resource])).digest("hex") };
  }
  // Removed resources stay reserved and their storage is retained for restoration.
  return ledger;
}
