import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";

import { artifactAppHtml, artifactAppResult, type ArtifactAppPayload } from "../src/mcp/app";
import { ArtifactService } from "../src/service";
import { tempDir, writeArtifact } from "../src/test/fixtures";

const INTERACTIVE_ARTIFACT = `import { Button, H1, Stack, Text, useArtifactAction, useArtifactState, useHostTheme } from "sidequery/artifacts";

export default function Interactive() {
  const [count, setCount] = useArtifactState<number>("count", 0);
  const act = useArtifactAction();
  const theme = useHostTheme();
  return (
    <Stack gap={8}>
      <H1>Interactive artifact</H1>
      <Text>Count: {count}</Text>
      <Text>Theme: {theme.kind}</Text>
      <Button onClick={() => setCount(value => value + 1)}>Increment</Button>
      <form onSubmit={event => { event.preventDefault(); setCount(value => value + 1); }}><button type="submit">Submit count</button></form>
      <Button onClick={() => act({ type: "promptAgent", prompt: "Explain this artifact" })}>Prompt agent</Button>
      <Button onClick={() => act({ type: "openUrl", url: "https://example.com/artifact" })}>Open docs</Button>
    </Stack>
  );
}
`;

const RESIZABLE_ARTIFACT = `import { Button, H1, Stack, Text, useArtifactState } from "sidequery/artifacts";

export default function Resizable() {
  const [expanded, setExpanded] = useArtifactState<boolean>("expanded", false);
  const rows = expanded ? 45 : 2;
  return (
    <Stack gap={8}>
      <H1>Resizable artifact</H1>
      <Text>This deliberately long sentence wraps onto more lines when the host makes the artifact narrow, while remaining fully readable.</Text>
      <Button onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</Button>
      {Array.from({ length: rows }, (_, index) => <Text key={index}>Content row {index + 1}</Text>)}
      <Text>Last content</Text>
    </Stack>
  );
}
`;

const SERVER_ARTIFACT = `import { Button, H1, Stack, Text, artifactFetch, useArtifactState } from "sidequery/artifacts";

export default function ServerArtifact() {
  const [result, setResult] = useArtifactState<string>("result", "idle");
  const load = async () => {
    try {
      const response = await artifactFetch("/api/items?limit=2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "artifact" }),
      });
      setResult(String(response.status) + ":" + await response.text());
    } catch (error) {
      setResult("error:" + (error instanceof Error ? error.message : String(error)));
    }
  };
  return (
    <Stack gap={8}>
      <H1>Server artifact</H1>
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
const transferRequests: Array<{ method: string; body: string }> = [];
const TRANSFER_FILE = { id: "one", name: "report.txt", size: 5, type: "text/plain", uploaded: "2026-10-03T00:00:00Z" };
// A web host's outer sandbox relays JSON-RPC and loads content only after the
// SDK resource-ready handshake. Codex's iframe fallback permits forms; every
// ancestor must permit them or the browser suppresses React submit handlers.
// The test still keeps the app in its own opaque inner frame.
const SANDBOX_PROXY_HTML = `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe id="sandbox" sandbox="allow-scripts allow-forms"></iframe><script>
const frame = document.getElementById("sandbox");
window.addEventListener("message", event => {
  if (event.source === parent) {
    if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
      frame.setAttribute("sandbox", event.data.params.sandbox || "allow-scripts allow-forms");
      frame.srcdoc = event.data.params.html;
    } else frame.contentWindow.postMessage(event.data, "*");
  } else if (event.source === frame.contentWindow) parent.postMessage(event.data, "*");
});
parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/sandbox-proxy-ready",params:{}}, "*");
</script></body></html>`;

async function resultFor(source: string, name: string, state: Record<string, unknown> = {}): Promise<{ artifact: ArtifactAppPayload }> {
  const dir = tempDir("artifact-mcp-browser-");
  fixtureDirs.add(dir);
  const path = writeArtifact(dir, name, source);
  writeFileSync(path.replace(".artifact.tsx", ".artifact.data.json"), JSON.stringify(state));
  const result = await artifactAppResult(new ArtifactService({
    artifactsDir: dir,
    cwd: dir,
    env: { ARTIFACTS_HISTORY_DB: join(dir, "history.sqlite") },
  }), { name });
  if (!("_meta" in result) || !result._meta) throw new Error("artifact result missing app metadata");
  return result._meta;
}

async function openHost(options: { openai?: boolean; minimal?: boolean; proxy?: boolean; deepLink?: string; result?: import("@modelcontextprotocol/sdk/types.js").CallToolResult } = {}): Promise<{ page: Page; app: FrameLocator; errors: string[]; logs: string[] }> {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  if (options.result) await page.addInitScript(result => { window.initialServerToolResult = result; }, options.result);
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
  const query = new URLSearchParams();
  if (options.openai) query.set("host", "openai");
  if (options.minimal) query.set("host", "minimal");
  if (options.proxy) query.set("proxy", "1");
  if (options.deepLink) query.set("deepLink", options.deepLink);
  await page.goto(`http://127.0.0.1:${server.port}/?${query}`);
  try {
    await page.waitForFunction(() => window.mcpHost?.initialized === true, undefined, { timeout: 5_000 });
  } catch {
    const frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator("body").innerText().catch(() => "") })));
    throw new Error(`MCP App did not initialize: ${JSON.stringify({ errors, logs, frames })}`);
  }
  return { page, app: options.proxy ? page.frameLocator("#app").frameLocator("#sandbox") : page.frameLocator("#app"), errors, logs };
}

async function layout(app: FrameLocator) {
  return app.locator("#artifact-shell").evaluate(shell => {
    const viewport = document.getElementById("artifact-viewport")!;
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
  const appHtml = (await artifactAppHtml()).replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src data:; frame-src 'none'; connect-src __artifact_transfer_origin__">`,
  );
  hostHtml = `<!doctype html><html><head><style>html,body{margin:0}iframe{display:block;border:0}</style></head><body><iframe id="app" sandbox="allow-scripts allow-forms"></iframe><script>window.artifactAppHtml=${JSON.stringify(appHtml).replaceAll("<", "\\u003c")}</script><script type="module">${hostJs.replaceAll("</script", "<\\/script")}</script></body></html>`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/sandbox-proxy") return new Response(SANDBOX_PROXY_HTML, { headers: { "content-type": "text/html" } });
      if (url.pathname.startsWith("/api/artifact/files/transfer/")) {
        const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT, GET, OPTIONS", "access-control-allow-headers": "content-type" };
        if (request.method === "OPTIONS") return new Response(null, { headers });
        transferRequests.push({ method: request.method, body: await request.text() });
        return Response.json({ file: TRANSFER_FILE }, { headers });
      }
      return new Response(hostHtml.replaceAll("__artifact_transfer_origin__", url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
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

test("renders and replaces interactive artifacts through the MCP Apps bridge", async () => {
  const dir = tempDir("artifact-mcp-browser-");
  fixtureDirs.add(dir);
  const db = join(dir, "history.sqlite");
  const sourcePath = writeArtifact(dir, "interactive", INTERACTIVE_ARTIFACT);
  const statePath = sourcePath.replace(".artifact.tsx", ".artifact.data.json");
  writeFileSync(statePath, '{"count":4}');
  const originalSource = readFileSync(sourcePath, "utf8");
  const originalSidecar = readFileSync(statePath, "utf8");
  const service = new ArtifactService({
    artifactsDir: dir,
    cwd: dir,
    env: { ARTIFACTS_HISTORY_DB: db },
  });
  const delivered = await artifactAppResult(service, { name: "interactive" });
  expect(delivered.ok).toBe(true);
  if (!("_meta" in delivered) || !delivered._meta) throw new Error("artifact result missing app metadata");

  const { page, app, errors } = await openHost();
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Artifact ready" }],
    _meta: delivered._meta,
  });

  await app.getByRole("heading", { name: "Interactive artifact" }).waitFor();
  await app.getByText("Count: 4").waitFor();
  await app.getByText("Theme: dark").waitFor();
  await app.getByRole("button", { name: "Increment" }).click();
  await app.getByText("Count: 5").waitFor();

  await app.getByRole("button", { name: "Prompt agent" }).click();
  await page.waitForFunction(() => window.mcpHost!.messages.length === 1);
  expect(await page.evaluate(() => window.mcpHost!.messages)).toEqual([
    { role: "user", content: [{ type: "text", text: "Explain this artifact" }] },
  ]);
  await app.getByRole("button", { name: "Open docs" }).click();
  await page.waitForFunction(() => window.mcpHost!.links.length === 1);
  expect(await page.evaluate(() => window.mcpHost!.links)).toEqual(["https://example.com/artifact"]);

  await page.evaluate(() => window.mcpHost!.setTheme("light"));
  await app.getByText("Theme: light").waitFor();
  expect(await app.locator("body").evaluate(body => getComputedStyle(body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(readFileSync(sourcePath, "utf8")).toBe(originalSource);
  expect(readFileSync(statePath, "utf8")).toBe(originalSidecar);

  const replacementPath = writeArtifact(dir, "replacement", INTERACTIVE_ARTIFACT.replace("Interactive artifact", "Replacement artifact"));
  writeFileSync(replacementPath.replace(".artifact.tsx", ".artifact.data.json"), '{"count":9}');
  const replacement = await artifactAppResult(service, { name: "replacement" });
  if (!("_meta" in replacement) || !replacement._meta) throw new Error("replacement result missing app metadata");
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Replacement ready" }],
    _meta: replacement._meta,
  });
  await app.getByRole("heading", { name: "Replacement artifact" }).waitFor();
  await app.getByText("Count: 9").waitFor();
  expect(await app.getByRole("heading", { name: "Interactive artifact" }).count()).toBe(0);

  await page.evaluate(async results => {
    await Promise.all(results.map(result => window.mcpHost!.sendResult(result)));
  }, [
    { content: [{ type: "text", text: "Old result" }], _meta: delivered._meta },
    { content: [{ type: "text", text: "Newest result" }], _meta: replacement._meta },
  ]);
  await app.getByRole("heading", { name: "Replacement artifact" }).waitFor();
  await page.waitForTimeout(100);
  expect(await app.getByRole("heading", { name: "Interactive artifact" }).count()).toBe(0);

  await page.evaluate(() => window.mcpHost!.cancel("Stopped by host"));
  await app.getByRole("status").waitFor();
  expect(await app.getByRole("status").textContent()).toBe("Artifact request cancelled.");
  expect(await app.getByRole("heading", { name: "Replacement artifact" }).count()).toBe(0);
  await page.evaluate(result => window.mcpHost!.sendResult(result), {
    content: [{ type: "text", text: "Replacement ready again" }],
    _meta: replacement._meta,
  });
  await app.getByRole("heading", { name: "Replacement artifact" }).waitFor();

  await page.evaluate(() => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Compilation failed" }],
    isError: true,
  }));
  await app.getByRole("status").waitFor();
  expect(await app.getByRole("status").textContent()).toBe("Compilation failed");
  expect(await app.getByRole("heading", { name: "Replacement artifact" }).count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("applies natural, capped, shrinking, narrow, and fixed inline sizes without feedback", async () => {
  const meta = await resultFor(RESIZABLE_ARTIFACT, "resizable");
  const { page, app, errors } = await openHost();
  await page.evaluate(meta => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Resizable ready" }],
    _meta: meta,
  }), meta);
  await app.getByRole("heading", { name: "Resizable artifact" }).waitFor();
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
  const viewportBox = (await app.locator("#artifact-viewport").boundingBox())!;
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
  const clampedViewportBox = (await app.locator("#artifact-viewport").boundingBox())!;
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
  const meta = await resultFor(INTERACTIVE_ARTIFACT, "modes", { count: 4 });
  const { page, app, errors } = await openHost();
  await page.evaluate(meta => window.mcpHost!.sendResult({
    content: [{ type: "text", text: "Modes ready" }],
    _meta: meta,
  }), meta);
  await app.getByText("Count: 4").waitFor();
  const iframe = page.locator("#app");
  const expand = app.getByRole("button", { name: "Expand artifact" });
  await expand.waitFor();
  const appearance = await expand.evaluate(button => {
    const viewport = document.getElementById("artifact-viewport")!;
    const shell = document.getElementById("artifact-shell")!;
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

test.each([false, true])("routes server requests for cached legacy runtime=%s only when enabled", async legacy => {
  const meta = await resultFor(SERVER_ARTIFACT, "server-data");
  if (legacy) meta.artifact.js = meta.artifact.js.replaceAll("__artifacts", "__herdrCanvas");
  meta.artifact.server = true;
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
    content: [{ type: "text", text: "Server artifact ready" }],
    _meta: meta,
  }), meta);
  await app.getByRole("heading", { name: "Server artifact" }).waitFor();
  const load = app.getByRole("button", { name: "Load server data" });
  await load.click();
  await app.getByText('Result: 202:{"rows":2}').waitFor();

  const calls = await page.evaluate(() => window.mcpHost!.serverToolCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("artifact_request");
  expect(Object.keys(calls[0]?.arguments ?? {}).sort()).toEqual(["request", "version_id", "workspace"]);
  expect(calls[0]?.arguments?.workspace).toBe(meta.artifact.workspace);
  expect(calls[0]?.arguments?.version_id).toBe(meta.artifact.versionId);
  const request = calls[0]?.arguments?.request as {
    path: string; method: string; headers: [string, string][]; body: string;
  };
  expect(request.path).toBe("/api/items?limit=2");
  expect(request.method).toBe("POST");
  expect(new Headers(request.headers).get("content-type")).toBe("application/json");
  expect(atob(request.body)).toBe('{"source":"artifact"}');

  await page.evaluate(() => window.mcpHost!.setServerToolResult({
    content: [{ type: "text", text: "Database unavailable" }],
    isError: true,
  }));
  await load.click();
  await app.getByText("Result: error:Database unavailable").waitFor();
  await page.evaluate(() => window.mcpHost!.setServerToolResult({ content: [], structuredContent: {} }));
  await load.click();
  await app.getByText("Result: error:Artifact server response was missing.").waitFor();

  const withoutServer = { artifact: { ...meta.artifact, server: false } };
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), withoutServer);
  await app.getByRole("heading", { name: "Server artifact" }).waitFor();
  await load.click();
  await app.getByText("Result: error:Artifact server requests are unavailable in this view.").waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.length)).toBe(3);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("ordinary React hooks update component state through the canonical and legacy SDK imports", async () => {
  const { HOOKS_ARTIFACT } = await import("../src/test/fixtures");
  for (const specifier of ["sidequery/artifacts", "herdr/canvas", "cursor/canvas"]) {
    const meta = await resultFor(HOOKS_ARTIFACT.replaceAll("sidequery/artifacts", specifier), "hooks");
    const { page, app, errors } = await openHost();
    await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
    await app.getByRole("button", { name: "Hooks 0:0:0:0:0", exact: true }).click();
    await app.getByRole("button", { name: "Hooks 1:3:1:2:1", exact: true }).click();
    await app.getByRole("button", { name: "Hooks 2:6:2:4:2", exact: true }).waitFor();
    expect(errors).toEqual([]);
    await page.close();
  }
}, 30000);


test("routes plugin calls through MCP and removes the bridge for an unavailable view", async () => {
  const source = `import { Button, pluginCall, useState } from "sidequery/artifacts";
export default function Artifact() {
  const [value, setValue] = useState("idle");
  return <><Button onClick={() => { pluginCall<string>("directory", "lookup", {id:"one"}).then(setValue).catch(e => setValue(e.message)); }}>Lookup</Button><p>{value}</p></>;
}`;
  const meta = await resultFor(source, "plugin-call");
  meta.artifact.plugins = true;
  const { page, app, errors } = await openHost();
  await page.evaluate(() => window.mcpHost!.setServerToolResult({ content: [], structuredContent: { result: "Found one" } }));
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("button", { name: "Lookup" }).click();
  await app.getByText("Found one").waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })))).toEqual([
    { name: "artifact_plugin_call", arguments: { plugin: "directory", operation: "lookup", input: { id: "one" } } },
  ]);
  await page.evaluate(() => window.mcpHost!.setServerToolResult({ content: [{ type: "text", text: "Operation denied" }], isError: true }));
  await app.getByRole("button", { name: "Lookup" }).click();
  await app.getByText("Operation denied").waitFor();
  meta.artifact.plugins = false;
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("button", { name: "Lookup" }).click();
  await app.getByText("Plugin functions are unavailable in this view").waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.length)).toBe(2);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);


test("routed artifacts navigate inside MCP and reset when a new preview arrives", async () => {
  const { ROUTING_ARTIFACT } = await import("../src/test/routing");
  const meta = await resultFor(ROUTING_ARTIFACT, "routed");
  const { page, app, errors } = await openHost();
  const outerUrl = page.url();
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("heading", { name: "Home page" }).waitFor();
  await app.getByRole("link", { name: "Account", exact: true }).click();
  await app.getByRole("heading", { name: "Account 123" }).waitFor();
  await app.getByText("Tab: activity", { exact: true }).waitFor();
  expect(page.url()).toBe(outerUrl);
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("heading", { name: "Home page" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30000);

test.each([false, true])("file tools and downloads support cached legacy runtime=%s without a server", async legacy => {
  const source = `import { Button, artifactFiles, useState } from "sidequery/artifacts";
export default function Artifact() {
  const [value, setValue] = useState("idle");
  return <><Button onClick={() => { artifactFiles.list().then(v => setValue(v.files[0]?.name ?? "empty")).catch(e => setValue(e.message)); }}>List files</Button><Button onClick={() => { artifactFiles.download("one").then(() => setValue("downloaded")).catch(e => setValue(e.message)); }}>Download file</Button><p>{value}</p></>;
}`;
  const meta = await resultFor(source, "files");
  if (legacy) meta.artifact.js = meta.artifact.js.replaceAll("__artifacts", "__herdrCanvas");
  meta.artifact.files = true;
  meta.artifact.server = false;
  const { page, app, errors } = await openHost();
  const file = { id: "one", name: "report.csv", size: 123, type: "text/csv", uploaded: "2026-09-07T00:00:00Z" };
  await page.evaluate(file => window.mcpHost!.setServerToolResult({ content: [], structuredContent: { result: { files: [file] } } }), file);
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("button", { name: "List files" }).click();
  await app.getByText("report.csv", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.map(({ name, arguments: args }) => ({ name, arguments: args })))).toEqual([
    { name: "artifact_files", arguments: { version_id: meta.artifact.versionId, workspace: meta.artifact.workspace, request: { operation: "list" } } },
  ]);
  const url = `https://artifact.example/api/${legacy ? "canvas" : "artifact"}/files/transfer/${"a".repeat(64)}/12345678-1234-1234-1234-123456789abc`;
  await page.evaluate(({ file, url }) => window.mcpHost!.setServerToolResult({ content: [], structuredContent: { result: { file, url, expires: "2026-09-07T00:05:00Z" } } }), { file, url });
  await app.getByRole("button", { name: "Download file" }).click();
  await app.getByText("downloaded", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.links)).toEqual([url]);
  expect(await page.evaluate(() => { const call = window.mcpHost!.serverToolCalls[1]!; return { name: call.name, arguments: call.arguments }; })).toEqual({ name: "artifact_files", arguments: { version_id: meta.artifact.versionId, workspace: meta.artifact.workspace, request: { operation: "download", id: "one" } } });
  await page.evaluate(() => window.mcpHost!.setServerToolResult({ content: [{ type: "text", text: "File access denied" }], isError: true }));
  await app.getByRole("button", { name: "List files" }).click();
  await app.getByText("File access denied", { exact: true }).waitFor();
  meta.artifact.files = false;
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("button", { name: "List files" }).click();
  await app.getByText("Artifact files are unavailable in this view.", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls.length)).toBe(3);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);


test("cached Canvas runtime receives state and themes and unmounts when replaced", async () => {
  const meta = await resultFor(INTERACTIVE_ARTIFACT, "cached", { count: 7 });
  // Archived JS carries the original globals/event names independently of today's compiler aliases.
  meta.artifact.js = meta.artifact.js.replaceAll("__artifacts", "__herdrCanvas").replaceAll("artifact-theme-change", "canvas-theme-change");
  const { page, app, errors } = await openHost();
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByText("Count: 7").waitFor();
  await app.getByRole("button", { name: "Increment" }).click();
  await app.getByText("Count: 8").waitFor();
  await page.evaluate(() => window.mcpHost!.setTheme("light"));
  await app.getByText("Theme: light").waitFor();
  await app.locator("#root").evaluate(() => {
    const host = window as typeof window & { __herdrCanvasUnmount?: () => void; legacyUnmounts?: number };
    const unmount = host.__herdrCanvasUnmount!;
    host.__herdrCanvasUnmount = () => { host.legacyUnmounts = (host.legacyUnmounts ?? 0) + 1; unmount(); };
  });
  const replacement = await resultFor(INTERACTIVE_ARTIFACT.replace("Interactive artifact", "Fresh artifact"), "fresh", { count: 2 });
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), replacement);
  await app.getByRole("heading", { name: "Fresh artifact" }).waitFor();
  await app.getByText("Count: 2").waitFor();
  expect(await app.locator("#root").evaluate(() => (window as typeof window & { legacyUnmounts?: number }).legacyUnmounts)).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30000);


const CONTEXT_ARTIFACT = `import { Button, H1, useArtifactContext, useHostEnvironment, getArtifactCapabilities } from "sidequery/artifacts";
export default function ContextArtifact() {
  const context = useArtifactContext();
  const environment = useHostEnvironment();
  const capabilities = getArtifactCapabilities();
  return <><H1>Context artifact</H1><p>Attached: {String(context.attached)}</p><p>Selected: {String(context.context?.selection?.row ?? "none")}</p><p>Locale: {environment.locale ?? "unset"}</p><p>Timezone: {environment.timeZone ?? "unset"}</p><p>Capabilities: {JSON.stringify(capabilities.actions)}</p><p>Model context: {String(capabilities.modelContext)}</p><p>Backend capabilities: {String(capabilities.server)}/{String(capabilities.files)}/{String(capabilities.plugins)}</p><Button disabled={!capabilities.modelContext} onClick={() => { void context.update({route:"/items",selection:{row:42},filters:{status:"open"}}); }}>Attach selection</Button></>;
}`;

function workspaceFor(artifact: ArtifactAppPayload, view: "library" | "working" = "library") {
  return { view, workspace: artifact.workspace ?? "default", nextOffset: null,
    items: [{ name: artifact.name, workspace: artifact.workspace ?? "default", working: true, versions: [{ id: artifact.versionId, revision: 1, createdAt: "2026-10-03T00:00:00Z" }] }] };
}

test("OpenAI model context reconciles user removal and remount without sending a prompt", async () => {
  const meta = await resultFor(CONTEXT_ARTIFACT, "context");
  meta.artifact.workspace = "analysis";
  const { page, app, errors, logs } = await openHost({ openai: true });
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByText("Attached: false", { exact: true }).waitFor();
  await app.getByRole("button", { name: "Attach selection" }).click();
  await app.getByText("Attached: true", { exact: true }).waitFor();
  await app.getByText("Selected: 42", { exact: true }).waitFor();
  const updates = await page.evaluate(() => window.mcpHost!.modelContexts);
  expect(updates).toHaveLength(1);
  expect(JSON.stringify(updates[0])).toContain(meta.artifact.versionId);
  expect(JSON.stringify(updates[0])).toContain('"row":42');
  expect(JSON.stringify(updates[0])).toContain('"workspace":"analysis"');
  expect(await page.evaluate(() => window.mcpHost!.messages)).toEqual([]);
  const workspace = workspaceFor(meta.artifact, "working");
  await page.evaluate(({ meta, workspace }) => window.mcpHost!.setServerToolResults({ artifacts_preview: [{ content: [], _meta: meta }], artifacts_search: [{ content: [], _meta: { workspace } }] }), { meta, workspace });
  await page.evaluate(workspace => window.mcpHost!.sendResult({ content: [], _meta: { workspace } }), workspace);
  const preview = app.frameLocator(".preview-frame");
  await preview.getByText("Attached: true", { exact: true }).waitFor().catch(async error => {
    const frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator("body").innerText().catch(() => "") })));
    throw new Error(`${error}: ${JSON.stringify({ errors, frames })}`);
  });
  expect(await page.evaluate(() => window.mcpHost!.modelContexts.length)).toBe(1);
  await page.evaluate(() => window.mcpHost!.removeModelContext());
  await preview.getByText("Attached: false", { exact: true }).waitFor();
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await preview.getByText("Attached: false", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.modelContexts.length)).toBe(1);
  await page.evaluate(() => window.mcpHost!.configure({ locale: "fr-FR", timeZone: "Europe/Paris", styles: { variables: { "--color-text-primary": "rgb(10, 20, 30)" } } }));
  await preview.getByText("Locale: fr-FR", { exact: true }).waitFor();
  await preview.getByText("Timezone: Europe/Paris", { exact: true }).waitFor();
  expect(await app.locator("html").getAttribute("lang")).toBe("fr-FR");
  expect(await app.locator("html").evaluate(element => element.style.getPropertyValue("--color-text-primary"))).toBe("rgb(10, 20, 30)");
  expect(errors).toEqual([]);
}, 30_000);

test("missing host capabilities leave ordinary rendering usable and disable context and actions", async () => {
  const meta = await resultFor(CONTEXT_ARTIFACT, "no-capabilities");
  meta.artifact.server = meta.artifact.files = meta.artifact.plugins = true;
  const { page, app, errors } = await openHost({ minimal: true });
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("heading", { name: "Context artifact" }).waitFor();
  expect(await app.getByRole("button", { name: "Attach selection" }).isDisabled()).toBe(true);
  await app.getByText('Capabilities: {"openUrl":false,"promptAgent":false,"openFile":false}', { exact: true }).waitFor();
  await app.getByText("Model context: false", { exact: true }).waitFor();
  await app.getByText("Backend capabilities: false/false/false", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.serverToolCalls)).toEqual([]);
  expect(errors).toEqual([]);
}, 30_000);

test("workspace keeps search and pinned revisions while its sandboxed preview remains interactive", async () => {
  const meta = await resultFor(INTERACTIVE_ARTIFACT, "chosen");
  meta.artifact.workspace = "research";
  const { page, app, errors } = await openHost({ proxy: true });
  const workspace = workspaceFor(meta.artifact);
  const empty = { ...workspace, items: [], nextOffset: 100 };
  await page.evaluate(({ meta, workspace, empty }) => {
    window.mcpHost!.configure({ displayMode: "fullscreen" });
    window.mcpHost!.setServerToolResults({
      artifacts_preview: [{ content: [], _meta: meta }],
      artifacts_search: [{ content: [], _meta: { workspace: empty } }, { content: [], _meta: { workspace } }],
    });
  }, { meta, workspace, empty });
  await page.evaluate(empty => window.mcpHost!.sendResult({ content: [], _meta: { workspace: { ...empty, view: "working", nextOffset: null } } }), empty);
  await app.getByRole("heading", { name: "Choose an artifact for this conversation" }).waitFor();
  expect(await app.getByRole("button", { name: "chosen", exact: true }).count()).toBe(0);
  await app.locator(".app-header").getByRole("button", { name: "Choose from library" }).click();
  await app.getByRole("searchbox").fill("chosen");
  await app.getByRole("button", { name: "chosen", exact: true }).click();
  const preview = app.frameLocator(".preview-frame");
  await preview.getByRole("heading", { name: "Interactive artifact" }).waitFor();
  await preview.getByRole("button", { name: "Increment" }).click();
  await preview.getByText("Count: 1", { exact: true }).waitFor();
  await preview.getByRole("button", { name: "Submit count" }).click();
  await preview.getByText("Count: 2", { exact: true }).waitFor();
  await app.getByLabel("Revision of chosen").selectOption(meta.artifact.versionId);
  await preview.getByRole("heading", { name: "Interactive artifact" }).waitFor();
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(version => window.mcpHost!.serverToolCalls.filter(call => call.name === "artifacts_preview" && call.arguments?.version_id === version).length >= 2, meta.artifact.versionId);
  const calls = await page.evaluate(() => window.mcpHost!.serverToolCalls);
  expect(calls.some(call => call.name === "artifacts_search" && call.arguments?.offset === 100)).toBe(true);
  await page.evaluate(() => window.mcpHost!.configure({ displayMode: "inline", containerDimensions: { width: 420, height: 600 } }));
  await app.getByRole("button", { name: "Back to library" }).click();
  expect(await app.getByRole("searchbox").inputValue()).toBe("chosen");
  expect(errors).toEqual([]);
}, 30_000);

test("OpenAI deep links select a revision through the server before entering its internal route", async () => {
  const { ROUTING_ARTIFACT } = await import("../src/test/routing");
  const meta = await resultFor(ROUTING_ARTIFACT, "linked");
  meta.artifact.workspace = "research";
  const query = new URLSearchParams({ workspace: "research", name: "linked", version_id: meta.artifact.versionId, route: "/accounts/456?tab=details" });
  const { page, app, errors } = await openHost({ openai: true, deepLink: `/artifact?${query}`, result: { content: [], _meta: meta } });
  await app.getByRole("heading", { name: "Account 456" }).waitFor();
  await app.getByText("Tab: details", { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.mcpHost!.serverToolCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "artifacts_preview", arguments: { workspace: "research", version_id: meta.artifact.versionId } });
  expect(errors).toEqual([]);
}, 30_000);

test("MCP gallery edits complete projects and retains drafts across navigation and conflicts", async () => {
  const meta = await resultFor(INTERACTIVE_ARTIFACT, "report");
  meta.artifact.workspace = "research";
  const workspace = workspaceFor(meta.artifact);
  const project = { files: { "lib/value.ts": "export const value = 1;" }, dependencies: {}, lock: {} };
  const source = { source: INTERACTIVE_ARTIFACT, server_source: "export default {};", project, revision_token: "a".repeat(64) };
  const gallery = {
    workspace: "research", nextOffset: null, capabilities: { editing: true, scripts: true, links: true },
    artifacts: [
      { ...workspace.items[0]!, key: "report", draftRevision: source.revision_token, versions: workspace.items[0]!.versions.map(version => ({ ...version, reason: "edit", serveCount: 0 })) },
      { key: "handler", kind: "script", name: "handler", workspace: "research", working: true, versions: [] },
    ],
  };
  const payload = { ...workspace, gallery };
  const { page, app, errors, logs } = await openHost({ openai: true, proxy: true });
  await page.evaluate(({ meta, payload, source }) => {
    window.mcpHost!.configure({ displayMode: "fullscreen" });
    window.mcpHost!.setServerToolResults({
      artifacts_search: [{ content: [], _meta: { workspace: payload } }],
      artifacts_preview: [{ content: [], _meta: meta }],
      artifacts_source: [{ content: [], structuredContent: source }],
      artifacts_tool: [{ content: [], isError: true, structuredContent: { error: "Project changed since it was loaded.", status: 409, applied: false } }],
    });
  }, { meta, payload, source });
  await page.evaluate(workspace => window.mcpHost!.sendResult({ content: [], _meta: { workspace } }), payload);
  await app.getByRole("tab", { name: "Source", exact: true }).click();
  const client = app.getByRole("textbox", { name: "report.artifact.tsx", exact: true });
  await client.fill("unsaved client");
  await app.getByRole("button", { name: "report.artifact.server.ts", exact: true }).click();
  await app.getByRole("textbox", { name: "report.artifact.server.ts", exact: true }).fill("unsaved server");
  await app.getByRole("combobox", { name: "Helper file" }).selectOption("file:lib/value.ts");
  await app.getByRole("textbox", { name: "lib/value.ts", exact: true }).fill("unsaved helper");
  await app.getByTitle("research/handler", { exact: true }).click();
  await app.getByRole("textbox", { name: "script.ts", exact: true }).fill("unsaved script");
  await app.getByTitle("research/report", { exact: true }).click();
  await app.getByRole("tab", { name: "Source", exact: true }).click();
  expect(await client.innerText()).toBe("unsaved client");
  await app.getByRole("button", { name: "Save and deploy", exact: true }).click();
  await app.getByRole("button", { name: "Compare saved project" }).waitFor().catch(async error => {
    throw new Error(`${error}: ${JSON.stringify({ text: await app.locator("body").innerText(), calls: await page.evaluate(() => window.mcpHost!.serverToolCalls), errors, logs })}`);
  });
  const calls = await page.evaluate(() => window.mcpHost!.serverToolCalls);
  const save = calls.find(call => call.name === "artifacts_tool");
  expect(save?.arguments).toEqual({ workspace: "research", tool: "artifact_write", arguments: {
    name: "report", contents: "unsaved client", server: "unsaved server",
    project: { files: { "lib/value.ts": "unsaved helper" }, dependencies: {} }, expected_revision: source.revision_token,
  } });
  await app.getByRole("button", { name: "Compare saved project" }).click();
  await app.getByText("Saved project (your edits remain in the editor)").waitFor();
  expect(await client.innerText()).toBe("unsaved client");
  await app.getByRole("button", { name: "Reload saved project" }).click();
  await app.getByRole("button", { name: "Keep editing", exact: true }).click();
  expect(await client.innerText()).toBe("unsaved client");
  await app.getByRole("button", { name: "Reload saved project" }).click();
  await app.getByRole("button", { name: "Discard edits and reload" }).click();
  await client.filter({ hasText: "Interactive artifact" }).waitFor();
  await app.getByLabel("Revision of report").selectOption(meta.artifact.versionId);
  await app.getByRole("button", { name: "Restore and deploy", exact: true }).waitFor();
  await client.and(app.locator('[aria-readonly="true"]')).waitFor();
  const historicalSource = await client.innerText();
  await client.focus();
  await page.keyboard.insertText("This must not change historical source");
  expect(await client.innerText()).toBe(historicalSource);
  expect(await app.locator(".live-data-note").innerText()).toContain("Historical code uses the current database");
  const screenshots = process.env.ARTIFACTS_SCREENSHOT_DIR;
  if (screenshots) {
    mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "artifacts-source-dark.png") });
    await page.evaluate(() => {
      window.mcpHost!.setTheme("light");
      window.mcpHost!.configure({ displayMode: "inline", containerDimensions: { width: 420, height: 700 } });
    });
    await page.screenshot({ path: join(screenshots, "artifacts-source-narrow.png") });
  }
  expect(errors).toEqual([]);
}, 30_000);

test("web sandbox proxy blocks unlisted network origins and permits granted artifact file transfers", async () => {
  const source = `import { Button, artifactFiles, useState } from "sidequery/artifacts";
export default function Transfer() { const [result,setResult]=useState("idle"); return <><Button onClick={() => { artifactFiles.upload(new Blob(["hello"],{type:"text/plain"}),{name:"report.txt"}).then(file => setResult("Uploaded " + file.name)).catch(error => setResult(error.message)); }}>Upload report</Button><p>{result}</p></>; }`;
  const meta = await resultFor(source, "transfer");
  meta.artifact.files = true;
  const { page, app, errors, logs } = await openHost({ proxy: true });
  const url = `http://127.0.0.1:${server.port}/api/artifact/files/transfer/${"a".repeat(64)}/12345678-1234-1234-1234-123456789abc`;
  await page.evaluate(({ file, url }) => window.mcpHost!.setServerToolResult({ content: [], structuredContent: { result: { file, url, expires: "2099-01-01T00:00:00Z" } } }), { file: TRANSFER_FILE, url });
  await page.evaluate(meta => window.mcpHost!.sendResult({ content: [], _meta: meta }), meta);
  await app.getByRole("button", { name: "Upload report" }).click();
  await app.getByText("Uploaded report.txt", { exact: true }).waitFor();
  expect(transferRequests).toContainEqual({ method: "PUT", body: "hello" });
  expect(await page.evaluate(() => window.mcpHost!.sandboxReady)).toBe(true);
  const blocked = await app.locator("body").evaluate(async () => {
    try { await fetch("https://example.com/forbidden"); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
  expect(logs.some(message => message.includes("connect-src") && message.includes("example.com/forbidden"))).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);


test("compatible refresh preserves route, session state and selected context while diagnostics keep the view mounted", async () => {
  const source = `import { Button, Link, useLocation, useArtifactState, useArtifactContext } from "sidequery/artifacts";
export default function RefreshArtifact() {
  const [count, setCount] = useArtifactState("count", 0);
  const context = useArtifactContext();
  const location = useLocation();
  return <><h1>Refresh artifact</h1><p>Count: {count}</p><p>Route: {location.pathname}</p><p>Selected: {String(context.context?.selection?.row ?? "none")}</p><Button onClick={() => setCount(value => value + 1)}>Increment</Button><Link to="/details">Details</Link><Button onClick={() => { void context.update({ selection: { row: 42 } }); }}>Attach row</Button></>;
}`;
  const meta = await resultFor(source, "refresh");
  meta.artifact.workspace = "research";
  const { page, app, errors } = await openHost({ openai: true });
  const workspace = workspaceFor(meta.artifact);
  await page.evaluate(({meta, workspace}) => {
    window.mcpHost!.configure({displayMode:"fullscreen"});
    window.mcpHost!.setServerToolResults({artifacts_preview:[{content:[],_meta:meta}],artifacts_search:[{content:[],_meta:{workspace}}]});
  }, {meta,workspace});
  const preview = app.frameLocator(".preview-frame");
  await page.evaluate(workspace => window.mcpHost!.sendResult({ content: [], _meta: { workspace } }), workspace);
  await preview.getByRole("heading", { name: "Refresh artifact", exact: true }).waitFor();
  await preview.getByRole("button", { name: "Increment", exact: true }).click();
  await preview.getByRole("link", { name: "Details", exact: true }).click();
  await preview.getByRole("button", { name: "Attach row", exact: true }).click();
  await preview.getByText("Selected: 42", { exact: true }).waitFor();
  await preview.getByText("Route: /details", { exact: true }).waitFor();
  await preview.getByText("Count: 1", { exact: true }).waitFor();
  await app.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => window.mcpHost!.serverToolCalls.filter(call => call.name === "artifacts_preview").length >= 2);
  await preview.getByText("Selected: 42", { exact: true }).waitFor();
  await preview.getByText("Route: /details", { exact: true }).waitFor();
  await preview.getByText("Count: 1", { exact: true }).waitFor();
  await page.evaluate(() => window.mcpHost!.sendResult({ content: [{ type: "text", text: "Saved without preview" }], structuredContent: { applied: true, ok: true, revision: 2 } }));
  await preview.getByText("Count: 1", { exact: true }).waitFor();
  await page.evaluate(() => window.mcpHost!.sendResult({ content: [{ type: "text", text: "Type error in new draft" }], isError: true }));
  await app.getByRole("status").filter({ hasText: "Type error in new draft" }).waitFor();
  await preview.getByText("Selected: 42", { exact: true }).waitFor();
  await preview.getByText("Route: /details", { exact: true }).waitFor();
  await preview.getByText("Count: 1", { exact: true }).waitFor();
  expect(await page.evaluate(() => window.mcpHost!.modelContexts.length)).toBe(1);
  expect(errors).toEqual([]);
}, 30_000);
