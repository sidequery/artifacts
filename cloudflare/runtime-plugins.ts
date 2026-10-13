import { createHash } from "node:crypto";
import { PluginError, PLUGIN_JSON_LIMIT, type PluginInvocationContext } from "../src/plugins/dispatch";
import {
  parseRuntimePlugin, runtimePluginInfo, runtimePluginKey, PLUGIN_NAME, RUNTIME_PLUGIN_MAX_BYTES, RUNTIME_PLUGIN_PREFIX,
  type RuntimePluginRecord,
} from "../src/plugins/runtime";
import type { PluginInfo, PluginUser } from "../src/plugins/types";
import { scriptRuntimeConfig } from "./script-runtime";

/** Without a `PLUGINS` binding there are no runtime plugins; build-time plugins are unaffected. */
export type RuntimePluginEnvironment = { PLUGINS?: R2Bucket; LOADER?: WorkerLoader; ARTIFACTS_RUNTIME?: string };

// Short, per-isolate caches: a republished plugin is picked up within seconds
// on every node without a host redeploy, and a busy dashboard does not read
// the bucket on every call.
const CACHE_MS = 5_000;
const ERROR_STATUSES = new Set([400, 403, 404, 413, 500, 504]);
const records = new Map<string, { at: number; record: RuntimePluginRecord | null }>();
let catalog: { at: number; plugins: PluginInfo[] } | undefined;

async function readRecord(bucket: R2Bucket, key: string, name: string): Promise<RuntimePluginRecord | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > RUNTIME_PLUGIN_MAX_BYTES) throw new Error("Plugin record exceeds 16 MiB");
  return parseRuntimePlugin(JSON.parse(await object.text()), name);
}

export async function runtimePlugin(env: RuntimePluginEnvironment, name: string): Promise<RuntimePluginRecord | null> {
  if (!env.PLUGINS || !PLUGIN_NAME.test(name)) return null;
  const cached = records.get(name);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.record;
  let record: RuntimePluginRecord | null;
  try { record = await readRecord(env.PLUGINS, runtimePluginKey(name), name); }
  catch (error) {
    console.error(`Runtime plugin ${name} could not be loaded`, error);
    throw new PluginError("Plugin configuration unavailable", 500);
  }
  records.set(name, { at: Date.now(), record });
  return record;
}

/** Catalog entries for every valid published plugin. An invalid record is
 * logged and left out of the listing; calling it still reports the error. */
export async function runtimePluginCatalog(env: RuntimePluginEnvironment): Promise<PluginInfo[]> {
  if (!env.PLUGINS) return [];
  if (catalog && Date.now() - catalog.at < CACHE_MS) return catalog.plugins;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PLUGINS.list({ prefix: RUNTIME_PLUGIN_PREFIX, cursor });
    keys.push(...page.objects.map(object => object.key).filter(key => key.endsWith(".json")));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length <= 64);
  const plugins: PluginInfo[] = [];
  for (const key of keys.slice(0, 64)) {
    const name = key.slice(RUNTIME_PLUGIN_PREFIX.length, -".json".length);
    try {
      const record = await readRecord(env.PLUGINS, key, name);
      if (record) plugins.push(runtimePluginInfo(record));
    } catch (error) { console.error(`Runtime plugin ${name} is invalid`, error); }
  }
  catalog = { at: Date.now(), plugins };
  return plugins;
}

/** Runs one operation in the plugin's own isolate. Its env holds only the
 * secrets the record declares, read from the host's bindings; host credentials,
 * Durable Objects and storage bindings never enter it. */
export async function callRuntimePlugin(record: RuntimePluginRecord, operation: string, input: unknown, user: PluginUser, context: PluginInvocationContext, timeoutMs = 30_000): Promise<unknown> {
  const env = context.env as RuntimePluginEnvironment & Record<string, unknown>;
  if (!env.LOADER) throw new PluginError("Plugin configuration unavailable", 500);
  const secrets: Record<string, string> = {};
  for (const name of record.secrets) {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof value !== "string") throw new PluginError("Plugin configuration unavailable", 500);
    secrets[name] = value;
  }
  const config = scriptRuntimeConfig(env.ARTIFACTS_RUNTIME);
  const key = createHash("sha256").update(JSON.stringify(["runtime-plugin", record.name, record.hash, secrets, config])).digest("hex");
  const worker = env.LOADER.get(key, async () => ({ ...config, mainModule: "plugin.js", modules: { "plugin.js": record.module }, env: secrets }));
  // The isolate enforces the same deadline; this bounds a module that never answers.
  const signal = AbortSignal.timeout(timeoutMs + 1_000);
  let text: string;
  try {
    const response = await worker.getEntrypoint().fetch(new Request("https://plugin.invalid/call", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input, user }), signal,
    }));
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw new PluginError("Plugin operation timed out", 504);
    console.error(`Runtime plugin ${record.name} failed to run`, error);
    throw new PluginError("Plugin operation failed", 500);
  }
  if (new TextEncoder().encode(text).byteLength > PLUGIN_JSON_LIMIT + 1024) throw new PluginError("Plugin result exceeds 256 KiB", 500);
  let reply: { result?: unknown; error?: unknown; status?: unknown };
  try { reply = JSON.parse(text); } catch { throw new PluginError("Plugin returned invalid JSON", 500); }
  if (reply && Object.hasOwn(reply, "result")) return reply.result;
  const status = typeof reply?.status === "number" && ERROR_STATUSES.has(reply.status) ? reply.status as 400 | 403 | 404 | 413 | 500 | 504 : 500;
  throw new PluginError(typeof reply?.error === "string" ? reply.error.slice(0, 200) : "Plugin operation failed", status);
}
