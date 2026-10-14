import { createHash } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import { PluginError, PLUGIN_JSON_LIMIT, type PluginInvocationContext } from "../src/plugins/dispatch";
import {
  parseRuntimePluginDescription, runtimePluginInfo, runtimePluginKey, PLUGIN_NAME, RUNTIME_PLUGIN_EXTENSION, RUNTIME_PLUGIN_MAX_BYTES, RUNTIME_PLUGIN_PREFIX,
  type RuntimePluginDescription,
} from "../src/plugins/runtime";
import type { PluginInfo, PluginUser } from "../src/plugins/types";
import { compilePluginSource } from "./compiler";
import { scriptRuntimeConfig } from "./script-runtime";

/** Without a `PLUGINS` binding there are no runtime plugins; build-time plugins are unaffected. */
export type RuntimePluginEnvironment = { PLUGINS?: R2Bucket; LOADER?: WorkerLoader; ARTIFACTS_RUNTIME?: string };
export type LoadedRuntimePlugin = {
  description: RuntimePluginDescription;
  /** SHA-256 of the source; part of the isolate cache key. */
  hash: string;
  module: string;
  validators: Map<string, { input: Validator; output?: Validator }>;
};

// Short, per-isolate source cache: a republished plugin is picked up within
// seconds on every node without a host redeploy, and a busy dashboard does not
// read the bucket on every call. Compiled plugins are cached by source hash.
const CACHE_MS = 5_000;
const MAX_COMPILED = 32;
const ERROR_STATUSES = new Set([400, 403, 404, 413, 500, 504]);
const sources = new Map<string, { at: number; source: { text: string; hash: string } | null }>();
const compiled = new Map<string, Promise<LoadedRuntimePlugin>>();
let catalog: { at: number; plugins: PluginInfo[] } | undefined;

function runtimeConfig(env: RuntimePluginEnvironment) { return scriptRuntimeConfig(env.ARTIFACTS_RUNTIME); }

async function readSource(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > RUNTIME_PLUGIN_MAX_BYTES) throw new Error("Plugin source exceeds 1 MiB");
  const text = await object.text();
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}

/** Compiles the source, then asks the plugin to describe itself in an isolate
 * with no secrets. Only the description, which the host checks, leaves it. */
async function load(env: RuntimePluginEnvironment, name: string, source: { text: string; hash: string }): Promise<LoadedRuntimePlugin> {
  if (!env.LOADER) throw new Error("Runtime plugins need the LOADER binding");
  const build = await compilePluginSource(source.text);
  if (!build.ok) throw new Error(`Plugin ${name} did not compile: ${build.error}`);
  const config = runtimeConfig(env);
  const worker = env.LOADER.get(`runtime-plugin-describe:${source.hash}`, async () => ({ ...config, mainModule: "plugin.js", modules: { "plugin.js": build.js }, env: {} }));
  const response = await worker.getEntrypoint().fetch(new Request("https://plugin.invalid/describe", { method: "POST", signal: AbortSignal.timeout(10_000) }));
  const description = parseRuntimePluginDescription(await response.json(), name);
  const validators = new Map<string, { input: Validator; output?: Validator }>();
  for (const operation of description.operations) {
    // Draft 7 matches the Ajv default build-time plugins use. Validation is
    // interpreted: Workers cannot compile validators from generated code.
    validators.set(operation.name, {
      input: new Validator(operation.inputSchema as object, "7", false),
      ...(operation.outputSchema ? { output: new Validator(operation.outputSchema as object, "7", false) } : {}),
    });
  }
  return { description, hash: source.hash, module: build.js, validators };
}

function loaded(env: RuntimePluginEnvironment, name: string, source: { text: string; hash: string }) {
  const key = `${name}\0${source.hash}`;
  let plugin = compiled.get(key);
  if (!plugin) {
    plugin = load(env, name, source);
    // A failure is not cached: fixing the plugin is a republish, and the next call retries.
    plugin.catch(() => compiled.delete(key));
    compiled.set(key, plugin);
    while (compiled.size > MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
  }
  return plugin;
}

export async function runtimePlugin(env: RuntimePluginEnvironment, name: string): Promise<LoadedRuntimePlugin | null> {
  if (!env.PLUGINS || !PLUGIN_NAME.test(name)) return null;
  try {
    let cached = sources.get(name);
    if (!cached || Date.now() - cached.at >= CACHE_MS) {
      cached = { at: Date.now(), source: await readSource(env.PLUGINS, runtimePluginKey(name)) };
      sources.set(name, cached);
    }
    return cached.source ? await loaded(env, name, cached.source) : null;
  } catch (error) {
    console.error(`Runtime plugin ${name} could not be loaded`, error);
    throw new PluginError("Plugin configuration unavailable", 500);
  }
}

/** Catalog entries for every valid published plugin. A plugin that fails to
 * load is logged and left out of the listing; calling it reports the error. */
export async function runtimePluginCatalog(env: RuntimePluginEnvironment): Promise<PluginInfo[]> {
  if (!env.PLUGINS) return [];
  if (catalog && Date.now() - catalog.at < CACHE_MS) return catalog.plugins;
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PLUGINS.list({ prefix: RUNTIME_PLUGIN_PREFIX, cursor });
    names.push(...page.objects.map(object => object.key).filter(key => key.endsWith(RUNTIME_PLUGIN_EXTENSION))
      .map(key => key.slice(RUNTIME_PLUGIN_PREFIX.length, -RUNTIME_PLUGIN_EXTENSION.length)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && names.length <= 64);
  const plugins: PluginInfo[] = [];
  for (const name of names.slice(0, 64)) {
    try {
      const plugin = await runtimePlugin(env, name);
      if (plugin) plugins.push(runtimePluginInfo(plugin.description));
    } catch {}
  }
  catalog = { at: Date.now(), plugins };
  return plugins;
}

/** Runs one operation in the plugin's own isolate. Its env holds only the
 * secrets the plugin declares, read from the host's bindings; host credentials,
 * Durable Objects and storage bindings never enter it. */
export async function callRuntimePlugin(plugin: LoadedRuntimePlugin, operation: string, input: unknown, user: PluginUser, context: PluginInvocationContext, timeoutMs = 30_000): Promise<unknown> {
  const env = context.env as RuntimePluginEnvironment & Record<string, unknown>;
  const validators = plugin.validators.get(operation)!;
  if (!validators.input.validate(input).valid) throw new PluginError("Invalid plugin input", 400);
  const secrets: Record<string, string> = {};
  for (const name of plugin.description.secrets) {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof value !== "string") throw new PluginError("Plugin configuration unavailable", 500);
    secrets[name] = value;
  }
  const config = runtimeConfig(env);
  const key = createHash("sha256").update(JSON.stringify(["runtime-plugin", plugin.description.name, plugin.hash, secrets, config])).digest("hex");
  const worker = env.LOADER!.get(key, async () => ({ ...config, mainModule: "plugin.js", modules: { "plugin.js": plugin.module }, env: secrets }));
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
    console.error(`Runtime plugin ${plugin.description.name} failed to run`, error);
    throw new PluginError("Plugin operation failed", 500);
  }
  if (new TextEncoder().encode(text).byteLength > PLUGIN_JSON_LIMIT + 1024) throw new PluginError("Plugin result exceeds 256 KiB", 500);
  let reply: { result?: unknown; error?: unknown; status?: unknown };
  try { reply = JSON.parse(text); } catch { throw new PluginError("Plugin returned invalid JSON", 500); }
  if (reply && Object.hasOwn(reply, "result")) {
    if (validators.output && !validators.output.validate(reply.result).valid) throw new PluginError("Plugin returned invalid output", 500);
    return reply.result;
  }
  const status = typeof reply?.status === "number" && ERROR_STATUSES.has(reply.status) ? reply.status as 400 | 403 | 404 | 413 | 500 | 504 : 500;
  throw new PluginError(typeof reply?.error === "string" ? reply.error.slice(0, 200) : "Plugin operation failed", status);
}
