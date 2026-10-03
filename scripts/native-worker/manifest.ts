import type { MiniflareBinding, WorkerOptions } from "miniflare";
import type { AppManifest, ResourceLedger } from "../../cloudflare/native-worker/manifest";
export * from "../../cloudflare/native-worker/manifest";

export function nativeConfig(scope: string, manifest: AppManifest, code: string, ledger: ResourceLedger, secrets: Record<string, string>): WorkerOptions {
  if (Object.keys(secrets).some(name => !manifest.secrets.includes(name))) throw new Error("Undeclared secret supplied");
  for (const name of manifest.secrets) if (typeof secrets[name] !== "string") throw new Error(`Missing declared secret: ${name}`);
  const name = `app-${scope}`;
  const env: Record<string, MiniflareBinding> = Object.create(null);
  for (const [key, value] of Object.entries({ ...manifest.vars, ...secrets })) env[key] = { type: "text", value };
  const exports: NonNullable<WorkerOptions["config"]["exports"]> = { default: { type: "worker" } };
  for (const [bindingName, binding] of Object.entries(manifest.bindings)) {
    const id = ledger[binding.resource]!.id;
    if (binding.type === "durable-object") {
      env[bindingName] = { type: "durable-object", worker: name, exportName: binding.class_name };
      exports[binding.class_name] = { type: "durable-object", storage: "sqlite", unsafeUniqueKey: id };
    } else if (binding.type === "kv" || binding.type === "d1") env[bindingName] = { type: binding.type, id };
    else env[bindingName] = { type: binding.type, name: id };
  }
  return { config: {
    name, type: "worker", compatibilityDate: manifest.compatibility_date, compatibilityFlags: manifest.compatibility_flags,
    manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: code } } }, env, exports,
    triggers: [
      ...manifest.triggers.crons.map(schedule => ({ type: "scheduled" as const, schedule })),
      ...manifest.triggers.queues.map(resource => ({ type: "queue" as const, name: ledger[resource]!.id, maxBatchTimeout: 0, maxRetries: 3 })),
    ],
  }, dev: {} };
}
