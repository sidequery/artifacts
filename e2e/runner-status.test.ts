import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { compileCanvas } from "../src/compile";
import { canvasHtml } from "../src/html";
import { typecheckCanvas } from "../src/typecheck";
import type { Snapshot, Item } from "../examples/runner-status/types";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const fixedTime = new Date();
const created = new Date(Date.now() - 120_000).toISOString();
const job = (id: number, status: string, repo = "acme/api"): Item => ({
  id, name: status === "in_progress" ? "Build" : "Queued deploy", status, conclusion: null,
  html_url: id === 2 ? "javascript:alert(1)" : `https://github.com/${repo}/actions/jobs/${id}`,
  runner_id: status === "in_progress" ? 1 : null, runner_name: status === "in_progress" ? "runner-1" : null,
  labels: ["self-hosted"], started_at: status === "in_progress" ? created : null,
  steps: status === "in_progress" ? [{ name: "Checkout", number: 1, status: "completed", conclusion: "success", started_at: created }, { name: "Compile", number: 2, status: "in_progress", conclusion: null, started_at: created }] : [],
  repo, run: { id, name: "CI", display_title: "Release main", html_url: `https://github.com/${repo}/actions/runs/${id}`, head_branch: "main", head_sha: "123456789", status, created_at: created, run_number: id, run_attempt: 1 }, eligibleRunnerIds: [1, 2],
});
const fixture: Snapshot = {
  org: "acme", repos: ["acme/api", "acme/web"],
  runners: [
    { id: 1, name: "runner-1", status: "online", busy: true, labels: [{ name: "self-hosted" }] },
    { id: 2, name: "runner-2", status: "online", busy: false, labels: [{ name: "self-hosted" }] },
    { id: 3, name: "runner-3", status: "online", busy: true, labels: [{ name: "self-hosted" }] },
  ],
  jobs: [job(1, "in_progress"), job(2, "queued", "acme/web")],
  sources: [{ repo: "acme/api", fetchedAt: created, activeRuns: 1, stale: false }, { repo: "acme/web", fetchedAt: created, activeRuns: 1, stale: true }],
  runnerFetchedAt: created, checkedAt: created, errors: ["acme/web: GitHub request failed"], refreshSeconds: 45,
};
beforeAll(async () => {
  const source = new URL("../examples/runner-status/runner-status.canvas.tsx", import.meta.url).pathname;
  expect(typecheckCanvas(source)).toEqual([]);
  const compiled = await compileCanvas(source);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ok).toBe(true);
  const builds = await Promise.all(["gallery-request", "navigation-host"].map(name => Bun.build({ entrypoints: [new URL(`../src/runtime/${name}.ts`, import.meta.url).pathname], target: "browser", format: "iife" })));
  expect(builds.every(build => build.success)).toBe(true);
  const [bridge, host] = await Promise.all(builds.map(build => build.outputs[0]!.text()));
  // Captured from the original runner-status app, with no API data or credentials.
  const original = await Bun.file(new URL("./fixtures/runner-status-original.html", import.meta.url)).text();
  const paritySnapshot = { ...fixture, runners: fixture.runners.slice(0, 2), checkedAt: fixedTime.toISOString(), errors: [], sources: fixture.sources.map(source => ({ ...source, stale: false })) };
  const headers = { "content-type": "text/html; charset=utf-8" };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/original") return new Response(original, { headers });
    if (url.pathname === "/api/status") return Response.json(paritySnapshot);
    const context = { plugins: true, route: { path: url.pathname.slice(7) || "/", basePath: "/status", external: true } };
    // Exercise the actual Canvas document, including its default 24px root padding.
    const frame = canvasHtml({ title: "Runner status", canvasId: "runner-status", scriptUrl: "/unused.js" })
      .replace(/window\.__herdrCanvas = [^;]*;/, () => `window.__herdrCanvas=${JSON.stringify(context)};${bridge}`)
      .replace('<script type="module" src="/unused.js"></script>', () => `<script type="module">${compiled.js!.replace(/<\/script/gi, "<\\/script")}<\/script>`);
    const snapshot = url.searchParams.has("parity") ? paritySnapshot : url.searchParams.has("empty") ? { ...fixture, runners: [], jobs: [], errors: [], sources: [] } : fixture;
    return new Response(`<style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe sandbox="allow-scripts"></iframe><script>
      const frame=document.querySelector('iframe');window.fixture=${JSON.stringify(snapshot)};window.fail=${url.searchParams.has("fail")};window.requests=0;
      window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.type!=='canvas/plugin-request')return;window.requests++;setTimeout(()=>frame.contentWindow.postMessage({type:'canvas/plugin-response',id:event.data.id,...(window.fail?{error:'Fixture disconnected'}:{result:window.fixture})},'*'),50)});
      frame.srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")};window.__canvasNavigationHost={frame,basePath:'/status'};${host}
    <\/script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  } });
  browser = await chromium.launch({ headless: true });
}, 180000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("runner sample filters, expands steps, preserves stale data, and bookmarks runner details", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.port}/status/runners`);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Self-hosted runners" }).waitFor();
    await frame.getByText("Assignment not visible in monitored repositories", { exact: true }).waitFor();
    await frame.getByText("Partial or stale data.", { exact: true }).waitFor();
    expect(await frame.locator("body").evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(13, 17, 23)");
    expect(await frame.locator(".spinner").first().evaluate(element => getComputedStyle(element).animationName)).toBe("spin");
    if (process.env.RUNNER_STATUS_SCREENSHOTS) await page.screenshot({ path: "/tmp/runner-status-desktop.png" });
    await frame.getByRole("button", { name: "Expand all", exact: true }).click();
    expect(await frame.locator("details[open]").count()).toBe(1);
    await frame.getByText("Checkout", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Collapse all", exact: true }).click();
    expect(await frame.locator("details[open]").count()).toBe(0);
    await frame.getByLabel("Runner status", { exact: true }).selectOption("idle");
    expect(await frame.getByRole("link", { name: "runner-1", exact: true }).count()).toBe(0);
    await frame.getByRole("link", { name: "runner-2", exact: true }).waitFor();
    await frame.getByLabel("Runner status", { exact: true }).selectOption("");
    await frame.getByLabel("Repository", { exact: true }).selectOption("acme/api");
    expect(await frame.getByRole("link", { name: "runner-2", exact: true }).count()).toBe(0);
    await frame.getByLabel("Repository", { exact: true }).selectOption("");
    await frame.getByLabel("Filter runners and jobs").fill("runner-2");
    expect(await frame.getByRole("link", { name: "runner-1", exact: true }).count()).toBe(0);
    await frame.getByLabel("Filter runners and jobs").fill("");
    await frame.getByRole("button", { name: "Queued jobs 1", exact: true }).click();
    await frame.getByRole("heading", { name: "Queued jobs", exact: true }).waitFor();
    await frame.locator(".row .elapsed").filter({ hasText: "since run created" }).waitFor();
    await frame.getByText("2 label-matching runners · 1 idle", { exact: true }).waitFor();
    expect(await frame.getByText("Queued deploy", { exact: true }).getAttribute("href")).toBeNull();
    await frame.getByRole("button", { name: "Running jobs 1", exact: true }).click();
    await frame.getByRole("heading", { name: "Running jobs", exact: true }).waitFor();
    const duration = await frame.locator(".row .elapsed strong").textContent();
    await page.waitForTimeout(1200);
    expect(await frame.locator(".row .elapsed strong").textContent()).not.toBe(duration);
    await frame.getByRole("link", { name: "runner-1", exact: true }).click();
    await frame.getByRole("heading", { name: "runner-1", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/status/runners/1");
    await page.reload();
    await frame.getByRole("heading", { name: "runner-1", exact: true }).waitFor();
    await page.evaluate(() => { (window as any).fail = true; });
    await frame.getByRole("button", { name: /Refresh/ }).click();
    await frame.getByRole("alert").filter({ hasText: "Showing the last received snapshot." }).waitFor();
    await frame.getByText("Build", { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).fail = false; });
    await frame.getByRole("button", { name: /Refresh/ }).click();
    await frame.getByRole("alert").waitFor({ state: "detached" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await frame.locator(".global").evaluate(element => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width }))).toEqual({ x: 0, width: 390 });
    if (process.env.RUNNER_STATUS_SCREENSHOTS) await page.screenshot({ path: "/tmp/runner-status-mobile.png" });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 120000);

test("runner sample exposes initial failure, retry, empty pool and missing runner states", async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(30000);
  try {
    await page.goto(`http://127.0.0.1:${server.port}/status/runners?fail=1`);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("alert").filter({ hasText: "Fixture disconnected" }).waitFor();
    await frame.getByText("Runner status is unavailable. Use Refresh to retry.", { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).fail = false; });
    await frame.getByRole("button", { name: /Refresh/ }).click();
    await frame.getByText("Build", { exact: true }).waitFor();
    await page.evaluate(() => { const state = window as any; state.fixture = { ...state.fixture, checkedAt: new Date(Date.now() - 600_000).toISOString(), errors: [], sources: state.fixture.sources.map((source: any) => ({ ...source, stale: false })) }; });
    await frame.getByRole("button", { name: /Refresh/ }).click();
    await frame.getByText("The collector has not updated recently. Showing the last received snapshot.", { exact: true }).waitFor();
    await page.evaluate(() => { const state = window as any; state.fixture.errors = ["Runner status: unavailable"]; });
    await frame.getByRole("button", { name: /Refresh/ }).click();
    await frame.getByText(/Runner status is stale · last fetched/).waitFor();
    await page.goto(`http://127.0.0.1:${server.port}/status/runners?empty=1`);
    await frame.getByText("No matching runners", { exact: true }).waitFor();
    await page.goto(`http://127.0.0.1:${server.port}/status/runners/999`);
    await frame.getByRole("heading", { name: "Runner not found", exact: true }).waitFor();
    await frame.getByRole("link", { name: "All runners", exact: false }).click();
    await frame.getByRole("heading", { name: "Self-hosted runners", exact: true }).waitFor();
  } finally { await page.close(); }
}, 120000);

test("runner canvas preserves the original app's rendered layout, typography, controls and icons", async () => {
  const original = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const canvas = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  original.setDefaultTimeout(30000); canvas.setDefaultTimeout(30000);
  try {
    await original.clock.setFixedTime(fixedTime); await canvas.clock.setFixedTime(fixedTime);
    await original.goto(`http://127.0.0.1:${server.port}/original`);
    await canvas.goto(`http://127.0.0.1:${server.port}/status/runners?parity=1`);
    const frame = canvas.frameLocator("iframe");
    await original.getByText("Build", { exact: true }).waitFor();
    await frame.getByText("Build", { exact: true }).waitFor();
    expect(await frame.locator("#root").evaluate(element => getComputedStyle(element).padding)).toBe("0px");
    expect(await frame.locator(".nav.active").evaluate(element => ({ tag: element.tagName, underline: getComputedStyle(element).textDecorationLine }))).toEqual({ tag: "BUTTON", underline: "none" });
    expect(await frame.locator(".global .mark path").count()).toBe(1);
    expect(await frame.locator(".top-tab .icon path").count()).toBe(1);
    expect(await frame.locator(".runner-name .icon path").count()).toBe(2);
    expect(await frame.locator(".stat-value.yellow").evaluate(element => getComputedStyle(element).color)).toBe("rgb(210, 153, 34)");
    await frame.getByText("Private", { exact: true }).waitFor();
    await frame.getByText("1 runners available", { exact: true }).waitFor();
    await frame.getByRole("button", { name: /↻.*Refresh/ }).waitFor();
    const selectors = ["body", ".global", ".global .mark", ".crumb", ".tabbar", ".top-tab", "aside", ".nav.active", ".main", ".heading", "h1", ".subtitle", ".stats", ".stat", ".stat-label", ".stat-value", ".stat-detail", ".toolbar", ".toolbar input", ".panel", ".panel-head", ".row", ".runner-name", ".pill.busy", ".label", ".job-title", ".job-meta", ".step-line", ".elapsed", ".queue-context", ".footer"];
    const measure = (selectors: string[]) => Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(selector)!;
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, font: css.font, color: css.color, background: css.backgroundColor, padding: css.padding, border: css.border, gap: css.gap }];
    }));
    for (const width of [1280, 390]) {
      await original.setViewportSize({ width, height: 1000 }); await canvas.setViewportSize({ width, height: 1000 });
      const expected = await original.evaluate(measure, selectors);
      const actual = await frame.locator("body").evaluate((_body, selectors) => {
        return Object.fromEntries(selectors.map(selector => {
          const element = document.querySelector(selector)!;
          const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, font: css.font, color: css.color, background: css.backgroundColor, padding: css.padding, border: css.border, gap: css.gap }];
        }));
      }, selectors);
      const differences: string[] = [];
      for (const selector of selectors) {
        for (const prop of ["x", "y", "width", "height"] as const) {
          if (Math.abs(actual[selector]![prop] - expected[selector]![prop]) >= 0.5) differences.push(`${width}px ${selector} ${prop}: expected ${expected[selector]![prop]}, got ${actual[selector]![prop]}`);
        }
        for (const prop of ["font", "color", "background", "padding", "border", "gap"] as const) {
          if (actual[selector]![prop] !== expected[selector]![prop]) differences.push(`${width}px ${selector} ${prop}: expected ${expected[selector]![prop]}, got ${actual[selector]![prop]}`);
        }
      }
      expect(differences).toEqual([]);
      if (process.env.RUNNER_STATUS_SCREENSHOTS) {
        await original.screenshot({ path: `/tmp/runner-status-original-${width}.png`, fullPage: true });
        await canvas.screenshot({ path: `/tmp/runner-status-canvas-${width}.png`, fullPage: true });
      }
    }
  } finally { await original.close(); await canvas.close(); }
}, 120000);
