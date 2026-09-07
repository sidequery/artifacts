import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";

import { canvasAppHtml, canvasAppResult, type CanvasAppPayload } from "../src/mcpApp";
import { CanvasService } from "../src/service";
import { tempDir, writeCanvas } from "../src/test/fixtures";

const INTERACTIVE_CANVAS = `import { Button, H1, Stack, Text, useCanvasAction, useCanvasState, useHostTheme } from "sidequery/canvas";

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

const RESIZABLE_CANVAS = `import { Button, H1, Stack, Text, useCanvasState } from "sidequery/canvas";

export default function Resizable() {
  const [expanded, setExpanded] = useCanvasState<boolean>("expanded", false);
  const rows = expanded ? 45 : 2;
  return (
    <Stack gap={8}>
      <H1>Resizable canvas</H1>
      <Text>This deliberately long sentence wraps onto more lines when the host makes the canvas narrow, while remaining fully readable.</Text>
      <Button onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</Button>
      {Array.from({ length: rows }, (_, index) => <Text key={index}>Content row {index + 1}</Text>)}
      <Text>Last content</Text>
    </Stack>
  );
}
`;

const SERVER_CANVAS = `import { Button, H1, Stack, Text, canvasFetch, useCanvasState } from "sidequery/canvas";

export default function ServerCanvas() {
  const [result, setResult] = useCanvasState<string>("result", "idle");
  const load = async () => {
    try {
      const response = await canvasFetch("/api/items?limit=2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "canvas" }),
      });
      setResult(String(response.status) + ":" + await response.text());
    } catch (error) {
      setResult("error:" + (error instanceof Error ? error.message : String(error)));
    }
  };
  return (
    <Stack gap={8}>
      <H1>Server canvas</H1>
      <Button onClick={() => { void load(); }}>Load server data</Button>
      <Text>Result: {result}</Text>
    </Stack>
  );
}
`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let hostHtml: string;
const fixtureDirs = new Set<string>();

async function resultFor(source: string, name: string, state: Record<string, unknown> = {}): Promise<{ canvas: CanvasAppPayload }> {
  const dir = tempDir("canvas-mcp-browser-");
  fixtureDirs.add(dir);
  const path = writeCanvas(dir, name, source);
  writeFileSync(path.replace(".canvas.tsx", ".canvas.data.json"), JSON.stringify(state));
  const result = await canvasAppResult(new CanvasService({
    canvasesDir: dir,
    cwd: dir,
    env: { HERDR_CANVAS_HISTORY_DB: join(dir, "history.sqlite") },
  }), { name });
  if (!("_meta" in result) || !result._meta) throw new Error("canvas result missing app metadata");
  return result._meta;
}

async function openHost(): Promise<{ page: Page; app: FrameLocator; errors: string[]; logs: string[] }> {
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
  return { page, app: page.frameLocator("#app"), errors, logs };
}

async function layout(app: FrameLocator) {
  return app.locator("#canvas-shell").evaluate(shell => {
    const viewport = document.getElementById("canvas-viewport")!;
    return {
      mode: document.documentElement.dataset.displayMode,
      shellHeight: shell.getBoundingClientRect().height,
      viewportHeight: viewport.getBoundingClientRect().height,
      viewportClientHeight: viewport.clientHeight,
      viewportScrollHeight: viewport.scrollHeight,
      viewportClientWidth: viewport.clientWidth,
      viewportScrollWidth: viewport.scrollWidth,
    };
  });
}

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
  hostHtml = `<!doctype html><html><head><style>html,body{margin:0}iframe{display:block;border:0}</style></head><body><iframe id="app" sandbox="allow-scripts"></iframe><script>window.canvasAppHtml=${JSON.stringify(appHtml).replaceAll("<", "\\u003c")}</script><script type="module">${hostJs.replaceAll("</script", "<\\/script")}</script></body></html>`;
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

  const { page, app, errors } = await openHost();
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Canvas ready" }],
    _meta: delivered._meta,
  });

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
  expect(await app.locator("body").evaluate(body => getComputedStyle(body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
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

test("applies natural, capped, shrinking, narrow, and fixed inline sizes without feedback", async () => {
  const meta = await resultFor(RESIZABLE_CANVAS, "resizable");
  const { page, app, errors } = await openHost();
  await page.evaluate(meta => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Resizable ready" }],
    _meta: meta,
  }), meta);
  await app.getByRole("heading", { name: "Resizable canvas" }).waitFor();
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height > 100);

  const iframe = page.locator("#app");
  const shortFrame = (await iframe.boundingBox())!;
  const shortLayout = await layout(app);
  expect(shortFrame.width).toBe(640);
  expect(shortFrame.height).toBeLessThan(600);
  expect(Math.abs(shortFrame.height - shortLayout.shellHeight)).toBeLessThanOrEqual(1);

  await app.getByRole("button", { name: "Show more" }).click();
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 600);
  const tallFrame = (await iframe.boundingBox())!;
  const tallLayout = await layout(app);
  expect(tallFrame.height).toBe(600);
  expect(tallLayout.shellHeight).toBe(600);
  expect(tallLayout.viewportScrollHeight).toBeGreaterThan(tallLayout.viewportClientHeight);
  const last = app.getByText("Last content");
  await last.scrollIntoViewIfNeeded();
  const lastBox = (await last.boundingBox())!;
  const viewportBox = (await app.locator("#canvas-viewport").boundingBox())!;
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(viewportBox.y + viewportBox.height + 1);

  await page.evaluate(() => window.mcpHost!.configure({ containerDimensions: { width: 640, maxHeight: 360 } }));
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 360);
  const tighterLayout = await layout(app);
  expect(tighterLayout.shellHeight).toBe(360);
  expect(tighterLayout.viewportScrollHeight).toBeGreaterThan(tighterLayout.viewportClientHeight);
  await page.evaluate(() => window.mcpHost!.configure({ containerDimensions: { width: 640, maxHeight: 600 } }));
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 600);

  await page.evaluate(() => window.mcpHost!.setInlineFrameLimit(350));
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 350);
  const silentlyClamped = await layout(app);
  expect(silentlyClamped.shellHeight).toBe(350);
  expect(silentlyClamped.viewportScrollHeight).toBeGreaterThan(silentlyClamped.viewportClientHeight);
  await last.scrollIntoViewIfNeeded();
  const clampedLastBox = (await last.boundingBox())!;
  const clampedViewportBox = (await app.locator("#canvas-viewport").boundingBox())!;
  expect(clampedLastBox.y + clampedLastBox.height).toBeLessThanOrEqual(clampedViewportBox.y + clampedViewportBox.height + 1);
  await page.evaluate(() => window.mcpHost!.setInlineFrameLimit());
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 600);

  await app.getByRole("button", { name: "Show less" }).click();
  await page.waitForFunction(previous => document.querySelector("iframe")!.getBoundingClientRect().height < previous - 100, tallFrame.height);
  const shrunkFrame = (await iframe.boundingBox())!;
  const shrunkLayout = await layout(app);
  expect(Math.abs(shrunkFrame.height - shrunkLayout.shellHeight)).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.mcpHost!.configure({ containerDimensions: { width: 280, maxHeight: 600 } }));
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().width === 280);
  await page.waitForFunction(previous => document.querySelector("iframe")!.getBoundingClientRect().height > previous, shrunkFrame.height);
  const narrowFrame = (await iframe.boundingBox())!;
  const narrowLayout = await layout(app);
  expect(narrowFrame.width).toBe(280);
  expect(narrowLayout.viewportScrollWidth).toBe(narrowLayout.viewportClientWidth);
  expect(Math.abs(narrowFrame.height - narrowLayout.shellHeight)).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.mcpHost!.configure({ containerDimensions: { width: 500, height: 420 } }));
  await page.waitForFunction(() => document.querySelector("iframe")!.getBoundingClientRect().height === 420);
  const fixedLayout = await layout(app);
  expect(fixedLayout.shellHeight).toBe(420);
  expect(fixedLayout.viewportHeight).toBe(420);

  await page.waitForTimeout(150);
  const stableCount = await page.evaluate(() => window.mcpHost!.sizeChanges.length);
  await page.waitForTimeout(150);
  const sizeChanges = await page.evaluate(() => window.mcpHost!.sizeChanges);
  expect(sizeChanges.length).toBe(stableCount);
  expect(sizeChanges.length).toBeLessThanOrEqual(24);
  expect(sizeChanges.every(change => change.width === undefined && typeof change.height === "number")).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("negotiates fullscreen while preserving state and survives external, declined, and failed changes", async () => {
  const meta = await resultFor(INTERACTIVE_CANVAS, "modes", { count: 4 });
  const { page, app, errors } = await openHost();
  await page.evaluate(meta => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Modes ready" }],
    _meta: meta,
  }), meta);
  await app.getByText("Count: 4").waitFor();
  const iframe = page.locator("#app");
  const expand = app.getByRole("button", { name: "Expand canvas" });
  await expand.waitFor();
  const appearance = await expand.evaluate(button => {
    const viewport = document.getElementById("canvas-viewport")!;
    const shell = document.getElementById("canvas-shell")!;
    return {
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      viewportTop: viewport.getBoundingClientRect().top,
      shellTop: shell.getBoundingClientRect().top,
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    };
  });
  expect(appearance.bodyBackground).toBe("rgba(0, 0, 0, 0)");
  expect(appearance.htmlBackground).toBe("rgba(0, 0, 0, 0)");
  expect(appearance.viewportTop).toBe(appearance.shellTop);
  expect(appearance.width).toBeGreaterThanOrEqual(44);
  expect(appearance.height).toBeGreaterThanOrEqual(44);
  await app.getByRole("button", { name: "Increment" }).click();
  await app.getByText("Count: 5").waitFor();

  await expand.focus();
  await expand.press("Enter");
  await app.locator('html[data-display-mode="fullscreen"]').waitFor();
  const fullscreenFrame = (await iframe.boundingBox())!;
  expect(fullscreenFrame.width).toBe((page.viewportSize()?.width ?? 1280) - 32);
  expect(fullscreenFrame.height).toBe((page.viewportSize()?.height ?? 720) - 32);
  expect((await layout(app)).shellHeight).toBe(fullscreenFrame.height);
  await app.getByText("Count: 5").waitFor();
  const fullscreenSizeCount = await page.evaluate(() => window.mcpHost!.sizeChanges.length);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.mcpHost!.sizeChanges.length)).toBe(fullscreenSizeCount);

  await app.getByRole("button", { name: "Exit fullscreen" }).click();
  await app.locator('html[data-display-mode="inline"]').waitFor();
  expect((await iframe.boundingBox())!.height).toBeLessThanOrEqual(600);
  await app.getByText("Count: 5").waitFor();

  await page.evaluate(() => window.mcpHost!.configure({ displayMode: "fullscreen" }));
  await app.getByRole("button", { name: "Exit fullscreen" }).waitFor();
  await page.evaluate(() => window.mcpHost!.configure({ displayMode: "inline" }));
  await expand.waitFor();
  await app.getByText("Count: 5").waitFor();

  await page.evaluate(() => window.mcpHost!.configure({ availableDisplayModes: ["inline"] }));
  await expand.waitFor({ state: "hidden" });
  expect(await expand.isVisible()).toBe(false);
  await page.evaluate(() => {
    window.mcpHost!.setRequestBehavior("decline");
    window.mcpHost!.configure({ availableDisplayModes: ["inline", "fullscreen"] });
  });
  await expand.waitFor();
  await expand.click();
  await app.getByRole("status").waitFor();
  expect(await app.getByRole("status").textContent()).toBe("The chat host did not change the display mode.");
  expect((await layout(app)).mode).toBe("inline");
  expect(await expand.isEnabled()).toBe(true);

  await page.evaluate(() => window.mcpHost!.setRequestBehavior("throw"));
  await expand.click();
  const status = app.getByRole("status");
  await status.filter({ hasText: "Unable to change display mode:" }).waitFor();
  expect((await status.textContent())?.startsWith("Unable to change display mode:")).toBe(true);
  expect((await layout(app)).mode).toBe("inline");
  expect(await expand.isEnabled()).toBe(true);
  await app.getByRole("button", { name: "Increment" }).click();
  await app.getByText("Count: 6").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("routes canvasFetch through canvas_request only for server-enabled MCP canvases", async () => {
  const meta = await resultFor(SERVER_CANVAS, "server-data");
  meta.canvas.server = true;
  const { page, app, errors } = await openHost();
  await page.evaluate(() => window.mcpHost!.setServerToolResult({
    content: [],
    structuredContent: {
      response: {
        status: 202,
        statusText: "Accepted",
        headers: [["content-type", "application/json"]],
        body: btoa('{"rows":2}'),
      },
    },
  }));
  await page.evaluate(meta => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Server canvas ready" }],
    _meta: meta,
  }), meta);
  await app.getByRole("heading", { name: "Server canvas" }).waitFor();
  const load = app.getByRole("button", { name: "Load server data" });
  await load.click();
  await app.getByText('Result: 202:{"rows":2}').waitFor();

  const calls = await page.evaluate(() => window.mcpHost!.serverToolCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("canvas_request");
  expect(Object.keys(calls[0]?.arguments ?? {}).sort()).toEqual(["request", "version_id"]);
  expect(calls[0]?.arguments?.version_id).toBe(meta.canvas.versionId);
  const request = calls[0]?.arguments?.request as {
    path: string; method: string; headers: [string, string][]; body: string;
  };
  expect(request.path).toBe("/api/items?limit=2");
  expect(request.method).toBe("POST");
  expect(new Headers(request.headers).get("content-type")).toBe("application/json");
  expect(atob(request.body)).toBe('{"source":"canvas"}');

  await page.evaluate(() => window.mcpHost!.setServerToolResult({
    content: [{ type: "text", text: "Database unavailable" }],
    isError: true,
  }));
  await load.click();
  await app.getByText("Result: error:Database unavailable").waitFor();
  await page.evaluate(() => window.mcpHost!.setServerToolResult({ content: [], structuredContent: {} }));
  await load.click();
  await app.getByText("Result: error:Canvas server response was missing.").waitFor();

  const withoutServer = { canvas: { ...meta.canvas, server: false } };
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), withoutServer);
  await app.getByRole("heading", { name: "Server canvas" }).waitFor();
  await load.click();
  await app.getByText("Result: error:Canvas server requests are unavailable in this view.").waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.length)).toBe(3);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("ordinary React hooks update component state through the canonical and legacy SDK imports", async () => {
  const { HOOKS_CANVAS } = await import("../src/test/fixtures");
  for (const specifier of ["sidequery/canvas", "herdr/canvas", "cursor/canvas"]) {
    const meta = await resultFor(HOOKS_CANVAS.replaceAll("sidequery/canvas", specifier), "hooks");
    const { page, app, errors } = await openHost();
    await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
    await app.getByRole("button", { name: "Hooks 0:0:0:0:0", exact: true }).click();
    await app.getByRole("button", { name: "Hooks 1:3:1:2:1", exact: true }).click();
    await app.getByRole("button", { name: "Hooks 2:6:2:4:2", exact: true }).waitFor();
    expect(errors).toEqual([]);
    await page.close();
  }
}, 30000);
