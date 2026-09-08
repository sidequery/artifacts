import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import type { GalleryArtifact } from "../src/gallery/types";

test("gallery filters, previews revisions, and preserves mobile library navigation without executing scripts", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const js = await build.outputs[0]!.text();
  const artifacts: GalleryArtifact[] = [
    {
      key: "campaign", name: "Campaign overview", workspace: "default", working: true,
      slug: "campaign", url: "/campaign", access: "private",
      versions: [{ id: "campaign-revision-1", revision: 1, createdAt: "2026-09-01T12:00:00Z", reason: "Initial report", serveCount: 0 }],
    },
    { key: "revenue", name: "Revenue report", workspace: "default", working: true, versions: [] },
    { key: "sync", kind: "script", name: "sync-customers", workspace: "default", working: true, versions: [] },
  ];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const sourceFor = (historical: boolean) => `export default function Report() { return <h1>${historical ? "Campaign revision 1" : "Current campaign"}</h1>; }`;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/session") return Response.json({});
      if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts, capabilities: { scripts: true, links: true } });
      if (url.pathname === "/api/source") {
        const source = url.searchParams.get("kind") === "script"
          ? 'export default { fetch() { return Response.json({ synced: true }); } };'
          : sourceFor(url.searchParams.has("version"));
        return url.searchParams.get("format") === "json"
          ? Response.json({ source, project: { files: {}, dependencies: {}, lock: {} } })
          : new Response(source);
      }
      if (url.pathname === "/gallery/preview") return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
        * { box-sizing: border-box } body { margin: 0; padding: clamp(20px, 5vw, 64px); background: #f6f5f1; color: #252722; font: 14px/1.6 system-ui }
        small { color: #686d62; text-transform: uppercase; letter-spacing: .12em } h1 { font-size: clamp(24px, 4vw, 40px); line-height: 1.2; margin: 12px 0 }
        p { color: #686d62 } section { border-top: 1px solid #d7dbcf; margin-top: 32px; padding-top: 20px; display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)) }
        strong { display: block; font-size: 28px; font-weight: 500 } span { color: #686d62 }
        </style></head><body><small>September 2026</small><h1>${url.searchParams.has("version") ? "Campaign revision 1" : "Campaign performance"}</h1><p>A clear view of the latest campaign results.</p><section><div><span>Visitors</span><strong>24,890</strong></div><div><span>Conversions</span><strong>1,284</strong></div><div><span>Conversion rate</span><strong>5.16%</strong></div></section></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/api/tools") {
        const call = await request.json() as typeof calls[number];
        calls.push(call);
        return Response.json({ structuredContent: {} });
      }
      if (url.pathname === "/") return new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
      return new Response("Not found", { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true });
  const screenshot = async (page: Page, name: string) => {
    const directory = process.env.GALLERY_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  };
  const noHorizontalOverflow = async (page: Page) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await desktop.goto(server.url.href);
    const library = desktop.getByRole("complementary", { name: "Artifacts and scripts" });
    const campaign = library.getByTitle("default/Campaign overview", { exact: true });
    const revenue = library.getByTitle("default/Revenue report", { exact: true });
    const script = library.getByTitle("default/sync-customers", { exact: true });
    await desktop.frameLocator('iframe[title="Preview of Campaign overview"]').getByRole("heading", { name: "Campaign performance" }).waitFor();
    expect(await campaign.getAttribute("aria-current")).toBe("true");
    expect(await desktop.getByRole("heading", { level: 1, name: "Campaign overview", exact: true }).isVisible()).toBe(true);
    expect(await desktop.getByRole("textbox", { name: "URL slug", exact: true }).isVisible()).toBe(false);
    expect((await campaign.boundingBox())!.height).toBeLessThanOrEqual(40);
    expect(await campaign.evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe("0px");
    const desktopFilters = (await desktop.getByRole("group", { name: "Filter library" }).boundingBox())!;
    expect((await campaign.boundingBox())!.y).toBe(desktopFilters.y + desktopFilters.height);
    await screenshot(desktop, "gallery-desktop-preview");

    const search = desktop.getByRole("searchbox", { name: "Search artifacts and scripts" });
    await search.fill("revenue");
    await campaign.waitFor({ state: "hidden" });
    expect(await revenue.isVisible()).toBe(true);
    expect(await script.count()).toBe(0);
    await search.fill("no-such-artifact");
    await revenue.waitFor({ state: "hidden" });
    await library.getByText("No matches", { exact: true }).waitFor();
    await desktop.getByRole("button", { name: "Clear search", exact: true }).click();
    await campaign.waitFor();
    expect(await search.inputValue()).toBe("");
    expect(await revenue.isVisible()).toBe(true);
    expect(await script.isVisible()).toBe(true);

    const filters = desktop.getByRole("group", { name: "Filter library" });
    await filters.getByRole("button", { name: "Artifacts", exact: true }).click();
    await script.waitFor({ state: "hidden" });
    expect(await campaign.isVisible()).toBe(true);
    expect(await revenue.isVisible()).toBe(true);
    await filters.getByRole("button", { name: "Scripts", exact: true }).click();
    await script.waitFor();
    expect(await campaign.count()).toBe(0);
    expect(await revenue.count()).toBe(0);
    await script.click();
    await desktop.getByRole("textbox", { name: "script.ts", exact: true }).waitFor();
    expect(await script.getAttribute("aria-current")).toBe("true");
    expect(calls).toEqual([]);
    await filters.getByRole("button", { name: "All", exact: true }).click();
    await campaign.click();
    expect(await campaign.getAttribute("aria-current")).toBe("true");
    expect(await script.getAttribute("aria-current")).toBeNull();

    await desktop.getByRole("group", { name: "Artifact view" }).getByRole("button", { name: "Source", exact: true }).click();
    const source = desktop.getByRole("textbox", { name: "Campaign overview.artifact.tsx", exact: true });
    await source.waitFor();
    expect(await source.innerText()).toBe(sourceFor(false));
    const dimensions = await desktop.locator(".source-code-surface:visible").evaluate(el => ({ editor: el.getBoundingClientRect().height, pane: el.closest(".artifact-detail")!.getBoundingClientRect().height }));
    expect(dimensions.editor).toBeGreaterThan(dimensions.pane / 2);
    expect(await source.locator("span").evaluateAll(spans => new Set(spans.map(el => getComputedStyle(el).color)).size)).toBeGreaterThan(1);
    const draft = sourceFor(false).replace("Current campaign", "Unsaved campaign");
    await source.fill(draft);
    await desktop.getByRole("group", { name: "Artifact view" }).getByRole("button", { name: "Preview", exact: true }).click();
    await desktop.getByRole("group", { name: "Artifact view" }).getByRole("button", { name: "Source", exact: true }).click();
    expect(await source.innerText()).toBe(draft);
    await noHorizontalOverflow(desktop);
    await screenshot(desktop, "gallery-desktop-source");
    await desktop.getByRole("combobox", { name: "Version", exact: true }).selectOption("campaign-revision-1");
    await desktop.getByRole("button", { name: "Restore revision", exact: true }).waitFor();
    await desktop.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Campaign overview.artifact.tsx"]')?.textContent?.includes("Campaign revision 1"));
    expect(await source.getAttribute("aria-readonly")).toBe("true");
    await desktop.getByRole("group", { name: "Artifact view" }).getByRole("button", { name: "Preview", exact: true }).click();
    await desktop.frameLocator('iframe[title="Preview of Campaign overview"]').getByRole("heading", { name: "Campaign revision 1" }).waitFor();
    expect(new URL(await desktop.getByTitle("Preview of Campaign overview").getAttribute("src") ?? "", server.url).searchParams.get("version")).toBe("campaign-revision-1");
    await desktop.getByRole("combobox", { name: "Version", exact: true }).selectOption("working");
    await desktop.frameLocator('iframe[title="Preview of Campaign overview"]').getByRole("heading", { name: "Campaign performance" }).waitFor();
    await desktop.getByRole("button", { name: "Link settings", exact: true }).click();
    await desktop.getByRole("textbox", { name: "URL slug", exact: true }).fill("campaign-report");
    expect(calls).toEqual([]);
    await desktop.getByRole("button", { name: "Save link", exact: true }).click();
    await desktop.getByRole("status").filter({ hasText: "Link saved" }).waitFor();
    expect(calls).toEqual([{ name: "artifact_link", arguments: { kind: "artifact", name: "Campaign overview", slug: "campaign-report", access: "private" } }]);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.goto(server.url.href);
    const mobileLibrary = mobile.getByRole("complementary", { name: "Artifacts and scripts", includeHidden: true });
    await mobileLibrary.getByTitle("default/Campaign overview", { exact: true }).waitFor();
    const mobileFilters = (await mobile.getByRole("group", { name: "Filter library" }).boundingBox())!;
    expect((await mobileLibrary.getByTitle("default/Campaign overview", { exact: true }).boundingBox())!.y).toBe(mobileFilters.y + mobileFilters.height);
    expect(await mobile.getByRole("heading", { level: 1, name: "Campaign overview", exact: true }).isVisible()).toBe(false);
    expect(await mobile.getByRole("button", { name: "Back to library", exact: true }).isVisible()).toBe(false);
    await noHorizontalOverflow(mobile);
    await screenshot(mobile, "gallery-mobile-library");
    const mobileSearch = mobile.getByRole("searchbox", { name: "Search artifacts and scripts" });
    await mobileSearch.fill("campaign");
    await mobile.getByRole("group", { name: "Filter library" }).getByRole("button", { name: "Artifacts", exact: true }).click();
    await mobileLibrary.getByTitle("default/Campaign overview", { exact: true }).click();
    await mobile.getByRole("heading", { level: 1, name: "Campaign overview", exact: true }).waitFor();
    expect(await mobileLibrary.isVisible()).toBe(false);
    await mobile.frameLocator('iframe[title="Preview of Campaign overview"]').getByRole("heading", { name: "Campaign performance" }).waitFor();
    await noHorizontalOverflow(mobile);
    await mobile.getByLabel("More actions", { exact: true }).click();
    expect(await mobile.getByRole("link", { name: "Download source", exact: true }).isVisible()).toBe(true);
    await mobile.getByLabel("More actions", { exact: true }).click();
    await screenshot(mobile, "gallery-mobile-preview");
    await mobile.getByRole("group", { name: "Artifact view" }).getByRole("button", { name: "Source", exact: true }).click();
    const mobileSource = mobile.getByRole("textbox", { name: "Campaign overview.artifact.tsx", exact: true });
    await mobileSource.waitFor();
    await mobileSource.fill(sourceFor(false).replace("Current campaign", "Mobile unsaved campaign"));
    await mobileSource.press("ControlOrMeta+Home");
    for (const control of [mobile.getByRole("combobox", { name: "Version", exact: true }), mobile.getByRole("button", { name: "Save artifact", exact: true }), mobile.getByRole("button", { name: "Find", exact: true }), mobile.getByText("Manage helper files", { exact: true }), mobile.getByText("Dependencies (0)", { exact: true })]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    }
    await noHorizontalOverflow(mobile);
    await screenshot(mobile, "gallery-mobile-source");
    await mobile.getByRole("button", { name: "Back to library", exact: true }).click();
    await mobileLibrary.waitFor();
    expect(await mobileSearch.inputValue()).toBe("campaign");
    expect(await mobileLibrary.getByTitle("default/Campaign overview", { exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
    expect(await mobile.getByRole("group", { name: "Filter library" }).getByRole("button", { name: "Artifacts", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await mobileLibrary.getByTitle("default/Campaign overview", { exact: true }).getAttribute("aria-current")).toBe("true");
    expect(await mobile.getByRole("heading", { level: 1, name: "Campaign overview", exact: true }).isVisible()).toBe(false);
    await mobile.getByRole("button", { name: "Clear search", exact: true }).click();
    await mobileLibrary.getByTitle("default/Revenue report", { exact: true }).waitFor();
    expect(await mobileLibrary.getByTitle("default/sync-customers", { exact: true }).count()).toBe(0);
    await noHorizontalOverflow(mobile);
    expect(calls.map(call => call.name)).toEqual(["artifact_link"]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 60000);
