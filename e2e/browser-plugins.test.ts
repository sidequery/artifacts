import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { prepareBrowserPlugins } from "../scripts/prepare-browser-plugins";
import { compileArtifact } from "../src/compile";
import { tempDir, writeArtifact } from "../src/test/fixtures";
import plugins from "../src/test/plugins/config";
const registry = await prepareBrowserPlugins(plugins, new URL("../src/test/plugins", import.meta.url).pathname);
const source = `import { PluginCounter } from "@test/counter";
export default function Artifact() { return <PluginCounter prefix="Plugin" />; }`;

test("prepared plugin hooks share the renderer React and execute an installed transitive library", async () => {
  const result = await compileArtifact(writeArtifact(tempDir(), "plugin", source), undefined, registry);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ type: "module", content: result.js! });
    await page.getByRole("button", { name: "UGx1Z2luIDA", exact: true }).click();
    await page.getByRole("button", { name: "UGx1Z2luIDE", exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);
