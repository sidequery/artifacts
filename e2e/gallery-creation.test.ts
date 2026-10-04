import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright";
import { createArtifactServer } from "../src/serve";
import type { GalleryArtifact } from "../src/gallery/types";

async function screenshot(page: Page, name: string) {
  const directory = process.env.GALLERY_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

async function newArtifact(page: Page) {
  await page.getByRole("button", { name: "Create or import", exact: true }).click();
  await page.getByRole("menuitem", { name: "New artifact", exact: true }).click();
}

test("local creation validates before saving, preserves existing names, and runs the starter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gallery-creation-"));
  const server = await createArtifactServer({ artifactsDir: directory, historyPath: join(directory, "history.sqlite"), gallery: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(10000);
    await page.goto(server.url);
    await newArtifact(page);
    await page.getByLabel("Artifact name", { exact: true }).fill("hello");
    const editor = page.getByRole("textbox", { name: "hello.artifact.tsx", exact: true });
    const starter = await editor.innerText();
    await editor.fill("export default function Artifact() { return <div>{missing}</div>; }");
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Fix the source errors" }).waitFor();
    expect(await Bun.file(join(directory, "hello.artifact.tsx")).exists()).toBe(false);
    expect(await editor.innerText()).toContain("{missing}");
    await editor.fill(starter);
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("heading", { name: "hello", exact: true }).waitFor();
    const preview = page.frameLocator('iframe[title="Preview of hello"]');
    await preview.getByRole("button", { name: "Count: 0", exact: true }).click();
    await preview.getByRole("button", { name: "Count: 1", exact: true }).waitFor();
    expect(await page.getByTitle(`${directory}/hello`, { exact: true }).getAttribute("aria-current")).toBe("true");
    expect(await Bun.file(join(directory, "hello.artifact.tsx")).text()).toBe(starter);
    await screenshot(page, "artifact-created");

    await newArtifact(page);
    await page.getByLabel("Artifact name", { exact: true }).fill("hello");
    await editor.fill(starter.replace("Hello", "Replacement"));
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
    expect(await Bun.file(join(directory, "hello.artifact.tsx")).text()).toBe(starter);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    const create = page.getByRole("button", { name: "Create or import", exact: true });
    await create.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["New artifact", "Import project"]);
    expect((await create.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, "create-menu-mobile");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Create or import");
    expect(await create.evaluate(element => element === document.activeElement)).toBe(true);
  } finally { await browser.close(); server.stop(); await rm(directory, { recursive: true, force: true }); }
}, 60000);

test("one creation menu preserves artifact drafts and retries saved invalid hosted revisions safely", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const artifacts: GalleryArtifact[] = [{ key: "existing", name: "existing", workspace: "default", working: true, versions: [] }];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const token = "a".repeat(64);
  let invalid = true;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts, capabilities: { links: true, scripts: true, nativeApps: true } });
    if (url.pathname === "/api/source") return Response.json({ source: "export default function Artifact() { return <div>Hello</div>; }", project: { files: {}, dependencies: {}, lock: {} }, revision_token: token });
    if (url.pathname === "/gallery/preview") return new Response("<p>Preview</p>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/tools") {
      const call = await request.json() as typeof calls[number];
      calls.push(call);
      if (call.arguments.name === "existing") return Response.json({ error: "Project already exists; choose another name." }, { status: 409 });
      if (invalid) {
        invalid = false;
        return Response.json({ isError: true, structuredContent: { applied: true, ok: false, revision_token: token, diagnostics: [{ severity: "error", file: "artifact.artifact.tsx", message: "Invalid source" }] } });
      }
      artifacts.push({ key: "created", name: String(call.arguments.name), workspace: "default", working: true, versions: [], access: "private" });
      return Response.json({ structuredContent: { ok: true, applied: true, revision_token: "b".repeat(64) } });
    }
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(5000);
    await page.goto(server.url.href);
    const create = page.getByRole("button", { name: "Create or import", exact: true });
    await create.click();
    await page.getByRole("menu").waitFor();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["New artifact", "New script", "New Worker app", "Import project"]);
    const heading = await page.locator(".library-heading").boundingBox();
    const search = await page.getByRole("searchbox").boundingBox();
    const plus = await create.boundingBox();
    expect(heading!.y + heading!.height).toBeLessThanOrEqual(search!.y);
    expect(plus!.x).toBeGreaterThan(search!.x);
    expect(plus!.x + plus!.width).toBeLessThanOrEqual(search!.x + search!.width + 4);
    expect(await page.getByRole("button", { name: "New Worker app", exact: true }).count()).toBe(0);
    expect(await page.getByText("Artifacts and scripts", { exact: true }).count()).toBe(0);
    await screenshot(page, "create-menu-desktop");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1000, height: 800 });
    await create.click();
    const tabletSearch = await page.getByRole("searchbox").boundingBox();
    const tabletPlus = await create.boundingBox();
    expect(tabletPlus!.x + tabletPlus!.width).toBeLessThanOrEqual(tabletSearch!.x + tabletSearch!.width + 4);
    await screenshot(page, "create-menu-tablet");
    await page.getByRole("menuitem", { name: "New artifact", exact: true }).click();
    await page.getByLabel("Artifact name", { exact: true }).fill("unfinished");
    await page.getByRole("textbox", { name: "unfinished.artifact.tsx", exact: true }).fill("unfinished source");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await newArtifact(page);
    expect(await page.getByLabel("Artifact name", { exact: true }).inputValue()).toBe("unfinished");
    expect(await page.getByRole("textbox", { name: "unfinished.artifact.tsx", exact: true }).innerText()).toBe("unfinished source");
    await page.getByLabel("Artifact name", { exact: true }).fill("existing");
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
    expect(calls[0]).toMatchObject({ name: "artifact_write", arguments: { name: "existing", expected_revision: null, access: "private" } });
    await page.getByLabel("Artifact name", { exact: true }).fill("new-artifact");
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Invalid draft saved" }).waitFor();
    expect(await page.getByLabel("Artifact name", { exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await newArtifact(page);
    await page.getByRole("textbox", { name: "new-artifact.artifact.tsx", exact: true }).fill("corrected source");
    await page.getByRole("button", { name: "Create artifact", exact: true }).click();
    await page.getByRole("heading", { name: "new-artifact", exact: true }).waitFor();
    expect(calls[2]).toMatchObject({ name: "artifact_write", arguments: { name: "new-artifact", expected_revision: token, contents: "corrected source", access: "private" } });
    expect(await page.getByTitle("default/new-artifact", { exact: true }).getAttribute("aria-current")).toBe("true");
    await newArtifact(page);
    expect(await page.getByLabel("Artifact name", { exact: true }).inputValue()).toBe("");
  } finally { await browser.close(); server.stop(true); }
}, 30000);
