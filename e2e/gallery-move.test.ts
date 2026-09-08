import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import type { GalleryArtifact } from "../src/gallery/types";

test("gallery moves artifacts and scripts between libraries, preserves selection, and keeps canceled or failed moves in place", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const js = await build.outputs[0]!.text();
  const workspace = "reports-west";
  const name = "shared-report";
  const item = (kind: "artifact" | "script", project = workspace): GalleryArtifact => ({ key: `${project}:${kind}:${name}`, kind, name, workspace: project, working: true, versions: [] });
  const libraries: Record<"private" | "team", GalleryArtifact[]> = {
    private: [item("artifact"), item("script"), item("artifact", "a-different-project"), item("script", "a-different-project")],
    team: [item("artifact", "a-different-project"), item("script", "a-different-project")],
  };
  const moves: { from: string; workspace: string; kind: string; name: string; library: string }[] = [];
  let collision = false;
  let local = false;
  const galleryRequests: URL[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") {
      galleryRequests.push(url);
      const library = url.searchParams.get("library") === "team" ? "team" : "private";
      const project = url.searchParams.get("workspace") ?? workspace;
      const artifacts = libraries[library].filter(artifact => url.searchParams.has("all") || artifact.workspace === project);
      return Response.json({ workspace: project, artifacts, ...(!local ? { libraryScope: library, capabilities: { scripts: true, links: true, moves: true } } : {}) });
    }
    if (url.pathname === "/api/source") return Response.json({ source: 'export default function Report() { return <h1>Report</h1>; }', project: { files: {}, dependencies: {}, lock: {} } });
    if (url.pathname === "/gallery/preview") return new Response("<h1>Report preview</h1>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/library/move" && request.method === "POST") {
      const body = await request.json() as { kind: string; name: string; library: "private" | "team" };
      const from = url.searchParams.get("library") as "private" | "team";
      const project = url.searchParams.get("workspace") ?? "";
      moves.push({ from, workspace: project, ...body });
      if (collision) return Response.json({ error: "An item with that name already exists in the destination library." }, { status: 409 });
      const index = libraries[from].findIndex(artifact => artifact.kind === body.kind && artifact.name === body.name && artifact.workspace === project);
      if (index < 0) return Response.json({ error: "Source not found" }, { status: 404 });
      libraries[body.library].push(libraries[from].splice(index, 1)[0]!);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/") return new Response('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
    return new Response("Not found", { status: 404 });
  } });
  const browser = await chromium.launch({ headless: true });
  const screenshot = async (page: Page, filename: string) => {
    const directory = process.env.GALLERY_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, filename), fullPage: true });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    for (const kind of ["artifact", "script"] as const) {
      await page.goto(`${server.url}?${new URLSearchParams({ library: "private", workspace, name, kind })}`);
      const selected = page.locator('.artifact-row[aria-current="true"]');
      await selected.waitFor();
      expect(await selected.getAttribute("title")).toBe(`${workspace}/${name}`);
      expect(await selected.innerText()).toBe(kind === "script" ? `${name}\nScript` : name);
      expect(await page.getByRole("combobox", { name: "Library", exact: true }).inputValue()).toBe("private");
      await page.getByRole("button", { name: "Move", exact: true }).click();
      const panel = page.getByRole("form", { name: "Move between libraries" });
      await panel.waitFor();
      expect(await panel.innerText()).toContain("including its data and secrets");
      expect(await panel.innerText()).toContain("Public links remain public");
      await screenshot(page, kind === "artifact" ? "gallery-move.png" : "gallery-move-script.png");
      const beforeCancel = moves.length;
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await panel.count()).toBe(0);
      expect(moves).toHaveLength(beforeCancel);
      await page.getByRole("button", { name: "Move", exact: true }).click();
      collision = true;
      await panel.getByRole("button", { name: "Move to team library", exact: true }).click();
      await panel.getByRole("alert").waitFor();
      expect(await panel.getByRole("alert").innerText()).toContain("already exists");
      expect(new URL(page.url()).searchParams.get("library")).toBe("private");
      expect(await page.getByRole("combobox", { name: "Library", exact: true }).inputValue()).toBe("private");
      expect(libraries.private.some(artifact => artifact.kind === kind && artifact.workspace === workspace)).toBe(true);
      collision = false;
      for (const [from, destination, action] of [["private", "team", "Move to team library"], ["team", "private", "Move to my personal library"]] as const) {
        if (from === "team") await page.getByRole("button", { name: "Move", exact: true }).click();
        await panel.getByRole("button", { name: action, exact: true }).click();
        await page.waitForURL(url => url.searchParams.get("library") === destination);
        await page.getByRole("combobox", { name: "Library", exact: true }).waitFor();
        await selected.waitFor();
        expect(await page.getByRole("combobox", { name: "Library", exact: true }).inputValue()).toBe(destination);
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ library: destination, workspace, name, kind });
        expect(await selected.getAttribute("title")).toBe(`${workspace}/${name}`);
        expect(await selected.innerText()).toBe(kind === "script" ? `${name}\nScript` : name);
        expect(moves.at(-1)).toEqual({ from, workspace, kind, name, library: destination });
        expect(libraries[from].some(artifact => artifact.kind === kind && artifact.workspace === workspace)).toBe(false);
        expect(libraries[destination].some(artifact => artifact.kind === kind && artifact.workspace === workspace)).toBe(true);
        expect(galleryRequests.at(-1)?.searchParams.get("workspace")).toBe(workspace);
      }
    }
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.goto(`${server.url}?${new URLSearchParams({ library: "private", workspace, name, kind: "artifact" })}`);
    const mobileItem = mobile.locator('.artifact-row[aria-current="true"]');
    await mobileItem.waitFor(); await mobileItem.click();
    await mobile.getByRole("button", { name: "Move", exact: true }).click();
    await mobile.getByRole("form", { name: "Move between libraries" }).waitFor();
    expect(await mobile.getByRole("combobox", { name: "Library", exact: true }).isVisible()).toBe(true);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const action of ["Move to team library", "Cancel"]) {
      const bounds = (await mobile.getByRole("form", { name: "Move between libraries" }).getByRole("button", { name: action, exact: true }).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    }
    await screenshot(mobile, "gallery-move-mobile.png");
    local = true;
    await page.reload();
    await page.locator('.artifact-row[aria-current="true"]').waitFor();
    expect(await page.getByRole("button", { name: "Move", exact: true }).count()).toBe(0);
    expect(await page.getByRole("combobox", { name: "Library", exact: true }).count()).toBe(0);
    expect(moves).toHaveLength(6);
  } finally { await browser.close(); server.stop(true); }
}, 60000);
