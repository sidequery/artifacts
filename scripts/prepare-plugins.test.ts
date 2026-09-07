import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePlugins, validatePlugins } from "./prepare-plugins";

test("builds server schemas and a public catalog without credentials or handler source", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-config-"));
  try {
    await writeFile(join(root, "canvas.plugins.ts"), `export default [{name:"directory",description:"Records",secrets:["DIRECTORY_TOKEN"],operations:{lookup:{description:"Lookup",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},outputSchema:{type:"string"},handler:()=>"HANDLER_ONLY_SENTINEL"}}}];`);
    const output = join(root, "dist");
    const prepared = await preparePlugins(root, output);
    expect(prepared.browser).toEqual({ modules: {}, files: {}, paths: {} });
    const catalog = await readFile(join(output, "plugin-catalog.json"), "utf8");
    expect(catalog).not.toContain("DIRECTORY_TOKEN");
    expect(catalog).not.toContain("HANDLER_ONLY_SENTINEL");
    const validator = await import(join(output, "plugin-validators.js"));
    expect(validator.validatePluginInput("directory", "lookup", { id: "one" })).toBe(true);
    expect(validator.validatePluginInput("directory", "lookup", { id: 1 })).toBe(false);
    expect(validator.validatePluginInput("directory", "missing", {})).toBe(false);
    expect(validator.validatePluginOutput("directory", "lookup", "ok")).toBe(true);
    expect(validator.validatePluginOutput("directory", "lookup", {})).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects ambiguous plugin config and requires explicit files to exist", async () => {
  const plugin = { name: "directory", description: "Records", browser: "jose" };
  expect(() => validatePlugins([plugin, plugin])).toThrow("unique");
  expect(() => validatePlugins([{ ...plugin, name: "react" }])).toThrow("reserved");
  expect(() => validatePlugins([{ ...plugin, browser: undefined }])).toThrow("must provide");
  await expect(preparePlugins(import.meta.dir, "/tmp/unused-plugin-output", "missing-config.ts")).rejects.toThrow("does not exist");
});
