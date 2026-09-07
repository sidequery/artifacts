import { expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prepareBrowserPlugins } from "../../scripts/prepare-browser-plugins";
import { compileCanvas } from "../compile";
import { typecheckCanvas } from "../typecheck";
import { tempDir, writeCanvas } from "../test/fixtures";

const source = `import { PluginCounter, type Label } from "@test/counter";
const label: Label = { prefix: "Plugin" };
export default function Canvas() { return <PluginCounter {...label} />; }`;
const plugin = { name: "@test/counter", description: "Counter fixture", browser: "./src/test/plugins/browser.tsx",
  secrets: ["PRIVATE_TOKEN"], operations: { serverOnly: { description: "server only", inputSchema: {}, handler: () => "SERVER_ONLY_SENTINEL" } } };
const registry = await prepareBrowserPlugins([plugin], new URL("../..", import.meta.url).pathname);

test("browser preparation captures transitive code and types without handlers or host paths", async () => {
  expect(Object.keys(registry.paths)).toEqual(["@test/counter"]);
  expect(Object.keys(registry.files).length).toBeGreaterThan(2);
  expect(JSON.stringify(registry)).not.toContain("SERVER_ONLY_SENTINEL");
  expect(JSON.stringify(registry)).not.toContain("PRIVATE_TOKEN");
  expect(Object.keys(registry.files).every(path => !path.startsWith("/") && !path.includes("../"))).toBe(true);
  expect(await prepareBrowserPlugins([], import.meta.dir)).toEqual({ modules: {}, files: {}, paths: {} });
});

test("local checking uses prepared transitive declarations and rejects deep or uninstalled imports", async () => {
  const path = writeCanvas(tempDir(), "plugin", source);
  expect(typecheckCanvas(path, registry)).toEqual([]);
  const invalidSdkType = source.replace("type Label", "type Label, type Tone").replace("const label", 'const tone: Tone = "invalid-tone"; const label');
  expect(typecheckCanvas(writeCanvas(tempDir(), "invalid-sdk-type", invalidSdkType), registry).some(item => item.message.includes("invalid-tone"))).toBe(true);
  const invalid = writeCanvas(tempDir(), "plugin", source.replace('prefix: "Plugin"', "prefix: 123"));
  expect(typecheckCanvas(invalid, registry).some(item => item.message.includes("number"))).toBe(true);
  const hiddenImport = source.replace('from "@test/counter";', 'from "@test/counter"; import "jose";');
  expect((await compileCanvas(path, hiddenImport, registry)).ok).toBe(false);
  expect((await compileCanvas(path, 'import{base64url}from"jose";export default()=> <div/>', registry)).ok).toBe(false);
  for (const specifier of ["@test/counter/deep", "jose", "uninstalled"]) {
    const denied = source.replace("@test/counter", specifier);
    expect(typecheckCanvas(writeCanvas(tempDir(), "denied", denied), registry)[0]?.message).toContain("not allowed");
    expect((await compileCanvas(path, denied, registry)).ok).toBe(false);
  }
}, 30000);


test("installed package entries and explicit JavaScript declarations keep their public type contracts", async () => {
  const prepared = await prepareBrowserPlugins([
    { name: "@test/encoding", description: "Installed library", browser: "jose" },
    { name: "@test/untyped", description: "Explicit types", browser: "./src/test/plugins/untyped.js", types: "./src/test/plugins/untyped.d.ts" },
  ], new URL("../..", import.meta.url).pathname);
  const canvas = `import { base64url } from "@test/encoding";
import { labelLength } from "@test/untyped";
export default function Canvas() { return <div>{base64url.encode(String(labelLength({prefix: "ok"})))}</div>; }`;
  expect(typecheckCanvas(writeCanvas(tempDir(), "installed", canvas), prepared)).toEqual([]);
  expect(typecheckCanvas(writeCanvas(tempDir(), "invalid", canvas.replace('prefix: "ok"', 'prefix: false')), prepared)
    .some(item => item.message.includes("boolean"))).toBe(true);
  expect((await compileCanvas(writeCanvas(tempDir(), "installed", canvas), undefined, prepared)).ok).toBe(true);
}, 30000);


test("package conditional exports select browser code and declarations from the configuration directory", async () => {
  const directory = tempDir();
  mkdirSync(join(directory, "node_modules"));
  cpSync(new URL("../test/plugins/conditional", import.meta.url), join(directory, "node_modules/conditional-browser-fixture"), { recursive: true });
  const prepared = await prepareBrowserPlugins([
    { name: "@test/conditional", description: "Browser conditions", browser: "conditional-browser-fixture" },
  ], directory);
  const module = await import(`data:text/javascript;base64,${Buffer.from(prepared.modules["@test/conditional"]!).toString("base64")}`);
  expect(module.environment).toBe("browser");
  expect(prepared.modules["@test/conditional"]).not.toContain("node:fs");
  const source = `import { environment } from "@test/conditional";
const browser: "browser" = environment;
export default function Canvas() { return <div>{browser}</div>; }`;
  expect(typecheckCanvas(writeCanvas(directory, "conditional", source), prepared)).toEqual([]);
}, 30000);
