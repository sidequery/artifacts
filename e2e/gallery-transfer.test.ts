import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createArtifactServer } from "../src/serve";
import { projectArchive } from "../src/project-archive";
import { VALID_ARTIFACT } from "../src/test/fixtures";

test("gallery imports a fresh complete project and exports its saved snapshot through authenticated downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gallery-transfer-"));
  const archive = projectArchive("artifact", { name: "portable", source: VALID_ARTIFACT, server_source: "preserved server source", project: { files: { "lib/value.ts": "export const value = 7;" }, dependencies: {}, lock: { "node_modules/archived/index.js": "export const value = 7;" } } });
  const server = await createArtifactServer({ artifactsDir: directory, historyPath: join(directory, "history.sqlite"), gallery: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    await page.route("**/api/session", route => route.fulfill({ json: { authMode: "better-auth", user: { id: "test", name: "Test owner", email: "test@example.test" } } }));
    await page.goto(server.url);
    await page.getByRole("button", { name: "Import project", exact: true }).click();
    await page.getByLabel("Project archive", { exact: true }).setInputFiles({ name: "portable.artifact-project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
    await page.waitForFunction(() => (document.querySelector('[aria-label="Imported project name"]') as HTMLInputElement)?.value === "portable-import");
    expect(await page.getByText("Includes backend source", { exact: false }).innerText()).toContain("1 helper files");
    await page.getByRole("button", { name: "Import as new project", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Project imported." }).waitFor();
    await page.getByRole("button", { name: "Import as new project", exact: true }).hover();
    expect(await page.getByRole("button", { name: "Import as new project", exact: true }).evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(42, 39, 35)");
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe("portable-import");
    if (process.env.GALLERY_SCREENSHOT_DIR) { await mkdir(process.env.GALLERY_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.GALLERY_SCREENSHOT_DIR, "gallery-project-import.png"), fullPage: true }); }
    await page.getByRole("button", { name: "Close import", exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download", exact: true }).click()]);
    expect(download.suggestedFilename()).toBe("portable-import.artifact-project.json");
    const path = join(directory, "export.json"); await download.saveAs(path);
    expect(await Bun.file(path).json()).toEqual({ ...archive, name: "portable-import" });
    expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("href")).toContain("format=project");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const shareUrl = await page.getByRole("textbox", { name: "Share link", exact: true }).inputValue();
    expect(shareUrl).toBe(`${server.url}/a/portable-import`);
    expect((await fetch(shareUrl)).status).toBe(200);
    expect(await page.getByText("This link works only on this Mac", { exact: false }).isVisible()).toBe(true);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Link copied" }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);
    const snapshot = await fetch(`${server.url}/api/source?name=portable-import&format=project`);
    expect(await snapshot.json()).toEqual({ ...archive, name: "portable-import" });
    if (process.env.GALLERY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.GALLERY_SCREENSHOT_DIR, "gallery-project-source.png"), fullPage: true });
  } finally { await browser.close(); server.stop(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
