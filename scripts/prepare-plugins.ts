import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone";
import type { CanvasPlugin } from "../src/plugins/config";
import type { PluginInfo } from "../src/plugins/types";
import { prepareBrowserPlugins } from "./prepare-browser-plugins";

const reserved = new Set(["react", "react-dom", "@sidequery/canvas"]);
export function validatePlugins(value: unknown): readonly CanvasPlugin[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Plugin config must export an array of at most 64 plugins");
  const names = new Set<string>();
  for (const plugin of value) {
    if (!plugin || typeof plugin.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(plugin.name)
      || reserved.has(plugin.name) || names.has(plugin.name)) throw new Error("Plugins need unique, non-reserved package names");
    names.add(plugin.name);
    if (typeof plugin.description !== "string" || plugin.description.length > 8192) throw new Error(`Invalid description for ${plugin.name}`);
    for (const field of ["browser", "types"]) if (plugin[field] !== undefined && (typeof plugin[field] !== "string" || !plugin[field])) throw new Error(`Invalid ${field} entry for ${plugin.name}`);
    if (plugin.types && !plugin.browser) throw new Error(`Types require a browser entry for ${plugin.name}`);
    if (plugin.secrets !== undefined && (!Array.isArray(plugin.secrets) || plugin.secrets.length > 32
      || plugin.secrets.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) throw new Error(`Invalid secret names for ${plugin.name}`);
    if (plugin.operations !== undefined && (!plugin.operations || typeof plugin.operations !== "object" || Array.isArray(plugin.operations))) throw new Error(`Invalid operations for ${plugin.name}`);
    const operations = Object.entries(plugin.operations ?? {});
    if (operations.length > 128) throw new Error(`Too many operations for ${plugin.name}`);
    if (!plugin.browser && !operations.length) throw new Error(`${plugin.name} must provide browser exports or server operations`);
    for (const [name, raw] of operations) {
      const operation = raw as Record<string, unknown>;
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || !operation || typeof operation.handler !== "function"
        || typeof operation.description !== "string" || operation.description.length > 8192) throw new Error(`Invalid operation ${plugin.name}/${name}`);
      if (operation.authorize !== undefined && typeof operation.authorize !== "function") throw new Error(`Invalid authorization for ${plugin.name}/${name}`);
      if (operation.readOnly !== undefined && typeof operation.readOnly !== "boolean") throw new Error(`Invalid readOnly for ${plugin.name}/${name}`);
      for (const field of ["inputSchema", "outputSchema"]) {
        if (field === "outputSchema" && operation[field] === undefined) continue;
        if (!operation[field] || typeof operation[field] !== "object" || Array.isArray(operation[field])) throw new Error(`Invalid ${field} for ${plugin.name}/${name}`);
      }
    }
  }
  return value as CanvasPlugin[];
}

export async function preparePlugins(root: string, output: string, selectedConfig = process.env.CANVAS_PLUGINS_CONFIG) {
  const configPath = resolve(root, selectedConfig ?? "canvas.plugins.ts");
  if (selectedConfig && !existsSync(configPath)) throw new Error("CANVAS_PLUGINS_CONFIG does not exist");
  const configured = existsSync(configPath);
  const plugins = validatePlugins(configured ? (await import(pathToFileURL(configPath).href)).default : []);
  const browser = await prepareBrowserPlugins(plugins, configured ? dirname(configPath) : root);
  const catalog: PluginInfo[] = plugins.map(plugin => ({
    name: plugin.name, description: plugin.description, browser: Boolean(plugin.browser),
    operations: Object.entries(plugin.operations ?? {}).map(([name, operation]) => ({
      name, description: operation.description, inputSchema: operation.inputSchema,
      ...(operation.outputSchema ? { outputSchema: operation.outputSchema } : {}), readOnly: operation.readOnly === true,
    })),
  }));
  const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: true } });
  const exports: Record<string, string> = {};
  const inputs: string[] = [], outputs: string[] = [];
  let index = 0;
  for (const plugin of catalog) for (const operation of plugin.operations) {
    const key = JSON.stringify(`${plugin.name}\0${operation.name}`);
    const inputName = `input${index}`, outputName = `output${index++}`;
    ajv.addSchema(operation.inputSchema, inputName); exports[inputName] = inputName;
    inputs.push(`${key}:${inputName}`);
    if (operation.outputSchema) {
      ajv.addSchema(operation.outputSchema, outputName); exports[outputName] = outputName;
      outputs.push(`${key}:${outputName}`);
    } else outputs.push(`${key}:()=>true`);
  }
  const validation = standaloneCode(ajv, exports) + `\nconst inputs={${inputs.join(",")}},outputs={${outputs.join(",")}};\n`
    + 'export function validatePluginInput(plugin,operation,input){const key=plugin+"\\0"+operation;return Object.hasOwn(inputs,key)&&inputs[key](input);}\n'
    + 'export function validatePluginOutput(plugin,operation,output){const key=plugin+"\\0"+operation;return Object.hasOwn(outputs,key)&&outputs[key](output);}\n';
  await mkdir(output, { recursive: true });
  let configImport = relative(output, configPath).replaceAll("\\", "/");
  if (!configImport.startsWith(".") && !isAbsolute(configImport)) configImport = `./${configImport}`;
  const server = configured ? `import plugins from ${JSON.stringify(configImport)};\nexport default plugins;\n`
    : 'import type { CanvasPlugin } from "../../src/plugins/config";\nexport default [] as readonly CanvasPlugin[];\n';
  await Promise.all([
    writeFile(join(output, "plugin-browser.json"), JSON.stringify(browser)),
    writeFile(join(output, "plugin-catalog.json"), JSON.stringify(catalog)),
    writeFile(join(output, "plugin-server.ts"), server),
    writeFile(join(output, "plugin-validators.js"), validation),
    writeFile(join(output, "plugin-validators.d.ts"), 'export function validatePluginInput(plugin:string,operation:string,input:unknown):boolean;\nexport function validatePluginOutput(plugin:string,operation:string,output:unknown):boolean;\n'),
  ]);
  return { browser, catalog };
}
