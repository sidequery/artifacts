import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

import { canvasAppHtml, canvasAppResult } from "../src/mcpApp";
import { CanvasService } from "../src/service";
import { tempDir, writeCanvas } from "../src/test/fixtures";

const INTERACTIVE_CANVAS = `import { Button, H1, Stack, Text, useCanvasAction, useCanvasState, useHostTheme } from "herdr/canvas";

export default function Interactive() {
  const [count, setCount] = useCanvasState<number>("count", 0);
  const act = useCanvasAction();
  const theme = useHostTheme();
  return (
    <Stack gap={8}>
      <H1>Interactive canvas</H1>
      <Text>Count: {count}</Text>
      <Text>Theme: {theme.kind}</Text>
      <Button onClick={() => setCount(value => value + 1)}>Increment</Button>
      <Button onClick={() => act({ type: "promptAgent", prompt: "Explain this canvas" })}>Prompt agent</Button>
      <Button onClick={() => act({ type: "openUrl", url: "https://example.com/canvas" })}>Open docs</Button>
    </Stack>
  );
}
`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let hostHtml: string;
const fixtureDirs = new Set<string>();

beforeAll(async () => {
  const hostBuild = await Bun.build({
    entrypoints: [join(import.meta.dir, "mcp-app-host.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!hostBuild.success) throw new Error(hostBuild.logs.join("\n"));
  const hostJs = await hostBuild.outputs[0]!.text();
  const appHtml = (await canvasAppHtml()).replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'">`,
  );
  hostHtml = `<!doctype html><html><body><iframe id="app" sandbox="allow-scripts"></iframe><script>window.canvasAppHtml=${JSON.stringify(appHtml).replaceAll("<", "\\u003c")}</script><script type="module">${hostJs.replaceAll("</script", "<\\/script")}</script></body></html>`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(hostHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

afterEach(async () => {
  for (const context of browser?.contexts() ?? []) await context.close();
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs.clear();
});

test("renders and replaces interactive canvases through the MCP Apps bridge", async () => {
  const dir = tempDir("canvas-mcp-browser-");
  fixtureDirs.add(dir);
  const db = join(dir, "history.sqlite");
  const sourcePath = writeCanvas(dir, "interactive", INTERACTIVE_CANVAS);
  const statePath = sourcePath.replace(".canvas.tsx", ".canvas.data.json");
  writeFileSync(statePath, '{"count":4}');
  const originalSource = readFileSync(sourcePath, "utf8");
  const originalSidecar = readFileSync(statePath, "utf8");
  const service = new CanvasService({
    canvasesDir: dir,
    cwd: dir,
    env: { HERDR_CANVAS_HISTORY_DB: db },
  });
  const delivered = await canvasAppResult(service, { name: "interactive" });
  expect(delivered.ok).toBe(true);
  if (!("_meta" in delivered) || !delivered._meta) throw new Error("canvas result missing app metadata");

  const page = await browser.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  try {
    await page.waitForFunction(() => window.mcpHost?.initialized === true, undefined, { timeout: 5_000 });
  } catch {
    const frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator("body").innerText().catch(() => "") })));
    throw new Error(`MCP App did not initialize: ${JSON.stringify({ errors, logs, frames })}`);
  }
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Canvas ready" }],
    _meta: delivered._meta,
  });

  const app = page.frameLocator("#app");
  await app.getByRole("heading", { name: "Interactive canvas" }).waitFor();
  await app.getByText("Count: 4").waitFor();
  await app.getByText("Theme: dark").waitFor();
  await app.getByRole("button", { name: "Increment" }).click();
  await app.getByText("Count: 5").waitFor();

  await app.getByRole("button", { name: "Prompt agent" }).click();
  await page.waitForFunction(() => window.mcpHost!.messages.length === 1);
  expect(await page.evaluate(() => window.mcpHost!.messages)).toEqual([
    { role: "user", content: [{ type: "text", text: "Explain this canvas" }] },
  ]);
  await app.getByRole("button", { name: "Open docs" }).click();
  await page.waitForFunction(() => window.mcpHost!.links.length === 1);
  expect(await page.evaluate(() => window.mcpHost!.links)).toEqual(["https://example.com/canvas"]);

  await page.evaluate(() => window.mcpHost!.setTheme("light"));
  await app.getByText("Theme: light").waitFor();
  expect(await app.locator("body").evaluate(body => getComputedStyle(body).backgroundColor)).toBe("rgb(255, 255, 255)");
  expect(readFileSync(sourcePath, "utf8")).toBe(originalSource);
  expect(readFileSync(statePath, "utf8")).toBe(originalSidecar);

  const replacementPath = writeCanvas(dir, "replacement", INTERACTIVE_CANVAS.replace("Interactive canvas", "Replacement canvas"));
  writeFileSync(replacementPath.replace(".canvas.tsx", ".canvas.data.json"), '{"count":9}');
  const replacement = await canvasAppResult(service, { name: "replacement" });
  if (!("_meta" in replacement) || !replacement._meta) throw new Error("replacement result missing app metadata");
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Replacement ready" }],
    _meta: replacement._meta,
  });
  await app.getByRole("heading", { name: "Replacement canvas" }).waitFor();
  await app.getByText("Count: 9").waitFor();
  expect(await app.getByRole("heading", { name: "Interactive canvas" }).count()).toBe(0);

  await page.evaluate(async results => {
    await Promise.all(results.map(result => window.mcpHost!.sendResult(result)));
  }, [
    { content: [{ type: "text", text: "Old result" }], _meta: delivered._meta },
    { content: [{ type: "text", text: "Newest result" }], _meta: replacement._meta },
  ]);
  await app.getByRole("heading", { name: "Replacement canvas" }).waitFor();
  await page.waitForTimeout(100);
  expect(await app.getByRole("heading", { name: "Interactive canvas" }).count()).toBe(0);

  await page.evaluate(() => window.mcpHost!.cancel("Stopped by host"));
  await app.getByRole("status").waitFor();
  expect(await app.getByRole("status").textContent()).toBe("Canvas request cancelled.");
  expect(await app.getByRole("heading", { name: "Replacement canvas" }).count()).toBe(0);
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Replacement ready again" }],
    _meta: replacement._meta,
  });
  await app.getByRole("heading", { name: "Replacement canvas" }).waitFor();

  await page.evaluate(() => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Compilation failed" }],
    isError: true,
  }));
  await app.getByRole("status").waitFor();
  expect(await app.getByRole("status").textContent()).toBe("Compilation failed");
  expect(await app.getByRole("heading", { name: "Replacement canvas" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);
