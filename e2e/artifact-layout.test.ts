import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createArtifactServer } from "../src/serve";
import { VIEWPORT_ARTIFACT, checkArtifactLayout } from "../src/test/artifact-layout";
import { tempDir, writeArtifact } from "../src/test/fixtures";

test("local artifacts and gallery previews fill the viewport without host padding", async () => {
  const directory = tempDir("artifact-layout-");
  writeArtifact(directory, "presentation", VIEWPORT_ARTIFACT);
  const server = await createArtifactServer({ artifactsDir: directory, historyPath: join(directory, "history.sqlite"), gallery: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const path of ["/c/presentation", "/gallery/preview?name=presentation"]) {
        expect((await page.goto(server.url + path))!.status()).toBe(200);
        await checkArtifactLayout(page);
      }
    }
  } finally {
    await browser.close();
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
