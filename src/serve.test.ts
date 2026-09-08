import { expect, test } from "bun:test";
import { join } from "node:path";

import { createArtifactServer } from "./serve";
import { VALID_ARTIFACT, tempDir, writeArtifact } from "./test/fixtures";

test("createArtifactServer serves compiled artifact HTML and JS", async () => {
  const dir = tempDir();
  writeArtifact(dir, "overview", VALID_ARTIFACT);
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: join(dir, "history.sqlite") });
  try {
    const health = await fetch(`${server.url}/health`);
    expect(health.ok).toBe(true);

    const page = await fetch(`${server.url}/c/overview`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("bundle.js");
    expect(html).toContain("__artifacts");

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

test("createArtifactServer persists artifact state", async () => {
  const dir = tempDir();
  writeArtifact(dir, "overview", VALID_ARTIFACT);
  const server = await createArtifactServer({ artifactsDir: dir, historyPath: join(dir, "history.sqlite") });
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
