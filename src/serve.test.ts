import { expect, test } from "bun:test";
import { join } from "node:path";

import { createCanvasServer } from "./serve";
import { VALID_CANVAS, tempDir, writeCanvas } from "./test/fixtures";

test("createCanvasServer serves compiled canvas HTML and JS", async () => {
  const dir = tempDir();
  writeCanvas(dir, "overview", VALID_CANVAS);
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: join(dir, "history.sqlite") });
  try {
    const health = await fetch(`${server.url}/health`);
    expect(health.ok).toBe(true);

    const page = await fetch(`${server.url}/c/overview`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("bundle.js");
    expect(html).toContain("__herdrCanvas");

    const js = await fetch(`${server.url}/c/overview/bundle.js`);
    expect(js.status).toBe(200);
    const bundle = await js.text();
    expect(bundle).toContain("Overview");

    const missing = await fetch(`${server.url}/c/missing`);
    expect(missing.status).toBe(404);
  } finally {
    server.stop();
  }
});

test("createCanvasServer persists canvas state", async () => {
  const dir = tempDir();
  writeCanvas(dir, "overview", VALID_CANVAS);
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: join(dir, "history.sqlite") });
  try {
    const put = await fetch(`${server.url}/c/overview/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "tab", value: "errors" }),
    });
    expect(put.ok).toBe(true);
    const get = await fetch(`${server.url}/c/overview/state`);
    expect(await get.json()).toEqual({ tab: "errors" });
  } finally {
    server.stop();
  }
});
