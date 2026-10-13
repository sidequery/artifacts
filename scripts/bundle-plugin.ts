import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { pluginInfo, pluginValidatorModule, validatePlugins } from "./prepare-plugins";
import { parseRuntimePlugin, runtimePluginKey, type RuntimePluginRecord } from "../src/plugins/runtime";

const root = resolve(import.meta.dir, "..");
const resolution = {
  // Validators import Ajv's runtime helpers; plugins may import the typed helper without installing the package.
  nodePaths: [join(root, "node_modules")],
  alias: { "@sidequery/artifacts/plugins": join(root, "src/plugins/config.ts") },
};

/** Reads the plugin definition from a bundle of its module, so a plugin kept in
 * another repository needs no install and the metadata comes from the code that ships. */
async function loadPlugin(entryPath: string, work: string): Promise<unknown> {
  const outfile = join(work, "definition.mjs");
  await build({ entryPoints: [entryPath], bundle: true, outfile, format: "esm", platform: "node", target: "es2022", logLevel: "silent", ...resolution });
  return (await import(pathToFileURL(outfile).href)).default;
}

/**
 * Builds the self-contained record a deployment loads from `plugins/<name>.json`
 * in its `PLUGINS` bucket. The plugin module's default export is one
 * `definePlugin(...)` with server operations. Its handlers, its dependencies, the
 * shared dispatcher and standalone schema validators are bundled into one ES
 * module, so the host never compiles or evaluates anything but that module, and
 * only inside the plugin's own isolate.
 */
export async function bundleRuntimePlugin(entry: string): Promise<RuntimePluginRecord> {
  const entryPath = resolve(entry);
  const work = await mkdtemp(join(tmpdir(), "artifacts-plugin-"));
  try {
    const [plugin] = validatePlugins([await loadPlugin(entryPath, work)]);
    if (plugin!.browser || plugin!.types) throw new Error(`${plugin!.name}: published plugins provide server operations only; browser modules need a deployment build`);
    if (!Object.keys(plugin!.operations ?? {}).length) throw new Error(`${plugin!.name} has no server operations`);
    const info = pluginInfo(plugin!);
    await writeFile(join(work, "validators.js"), pluginValidatorModule([info]));
    await writeFile(join(work, "entry.js"), [
      `import plugin from ${JSON.stringify(entryPath)};`,
      'import { validatePluginInput, validatePluginOutput } from "./validators.js";',
      `import { runtimePluginHandler } from ${JSON.stringify(join(root, "src/plugins/runtime-entry.ts"))};`,
      "export default runtimePluginHandler(plugin, { input: validatePluginInput, output: validatePluginOutput });",
    ].join("\n"));
    const bundle = await build({
      entryPoints: [join(work, "entry.js")], bundle: true, write: false, format: "esm", target: "es2022",
      platform: "browser", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], ...resolution,
      define: { "process.env.NODE_ENV": '"production"' }, legalComments: "none", logLevel: "silent",
      // Minified output carries no module path comments, so the same source and
      // lockfile produce the same bytes on any machine and from any directory, and
      // a deployment repo can check a committed bundle against its source.
      minify: true,
    });
    if (bundle.outputFiles.length !== 1) throw new Error(`${plugin!.name} must bundle into one module`);
    const module = bundle.outputFiles[0]!.text;
    return parseRuntimePlugin({
      format: 1, name: plugin!.name, description: plugin!.description, secrets: [...(plugin!.secrets ?? [])],
      operations: info.operations, module, hash: createHash("sha256").update(module).digest("hex"),
    });
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [entry, flag, out] = process.argv.slice(2);
  if (!entry || flag !== "--out" || !out) {
    console.error("usage: bun run scripts/bundle-plugin.ts <plugin.ts> --out <record.json>");
    process.exit(2);
  }
  const record = await bundleRuntimePlugin(entry);
  await writeFile(out, JSON.stringify(record));
  console.log(JSON.stringify({ name: record.name, key: runtimePluginKey(record.name), hash: record.hash, operations: record.operations.map(operation => operation.name), secrets: record.secrets }));
}
