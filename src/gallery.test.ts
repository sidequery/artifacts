import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CanvasHistory } from "./history";
import { PLUGIN_ROOT } from "./paths";
import { createCanvasServer } from "./serve";
import { tempDir, VALID_CANVAS, writeCanvas } from "./test/fixtures";
import type { GalleryData } from "./gallery/types";

test("gallery lists working copies and archived/deleted versions with an explicit all-projects filter", async () => {
  const dir = tempDir();
  writeCanvas(dir, "working", VALID_CANVAS);
  const dbPath = join(dir, "history.sqlite");
  const history = new CanvasHistory(dbPath);
  const archived = history.capture({ workspace: dir, name: "deleted", sourcePath: join(dir, "deleted.canvas.tsx"), source: VALID_CANVAS, runtime: "test" });
  const other = history.capture({ workspace: dir + "-other", name: "elsewhere", sourcePath: join(dir + "-other", "elsewhere.canvas.tsx"), source: VALID_CANVAS, runtime: "test" });
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath, gallery: true });
  try {
    const page = await (await fetch(server.url)).text();
    expect(page).toContain("Canvas library");
    const current = await (await fetch(`${server.url}/api/gallery`)).json() as GalleryData;
    expect(current.artifacts.map(item => [item.name, item.working])).toEqual([["deleted", false], ["working", true]]);
    expect(current.artifacts[0]?.versions[0]?.id).toBe(archived.id);
    const all = await (await fetch(`${server.url}/api/gallery?all=1`)).json() as GalleryData;
    expect(all.artifacts.map(item => item.name)).toEqual(["deleted", "elsewhere", "working"]);
    expect(history.list(dir)).toHaveLength(1); // Listing does not invent served versions.
    const downloaded = await fetch(`${server.url}/api/source?version=${other.id}&download=1`);
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
    expect(await downloaded.text()).toBe(VALID_CANVAS);
    expect(await (await fetch(`${server.url}/api/source?name=working`)).text()).toBe(VALID_CANVAS);
    expect((await fetch(`${server.url}/api/source?name=..%2foutside`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/source?version=${other.id}&name=working`)).status).toBe(400);
    expect((await fetch(`${server.url}/api/source?version=missing`)).status).toBe(404);
  } finally { server.stop(); history.close(); }
});

test("gallery previews carry a self-contained build and isolated state, including archived source from another project", async () => {
  const dir = tempDir();
  const path = writeCanvas(dir, "working", VALID_CANVAS);
  const statePath = path.replace(".tsx", ".data.json");
  writeFileSync(statePath, '{"count":7}');
  const dbPath = join(dir, "history.sqlite");
  const history = new CanvasHistory(dbPath);
  const other = history.capture({ workspace: dir + "-other", name: "deleted", sourcePath: join(dir + "-other", "deleted.canvas.tsx"), source: VALID_CANVAS, runtime: "test" });
  history.served(other.id, { count: 3 }, "live");
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: dbPath, gallery: true });
  try {
    const response = await fetch(`${server.url}/gallery/preview?name=working`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const bridge = JSON.parse(html.match(/window\.__herdrCanvas = (.*);<\/script>/)![1]);
    expect(bridge.state).toEqual({ count: 7 });
    expect(bridge.persistUrl).toBeUndefined();
    expect(bridge.actionUrl).toBeUndefined();
    const bundle = Buffer.from(html.match(/src="data:text\/javascript;base64,([^\"]+)"/)![1], "base64").toString();
    expect(bundle).toContain("Overview");
    expect(history.events(bridge.versionId)[0]?.mode).toBe("preview");
    expect(readFileSync(statePath, "utf8")).toBe('{"count":7}');
    expect((await fetch(`${server.url}/v/${other.id}`)).status).toBe(404); // Normal per-workspace API remains scoped.
    const archived = await fetch(`${server.url}/gallery/preview?version=${other.id}`);
    expect(archived.status).toBe(200);
    expect(await archived.text()).toContain('"state":{"count":3}');
    expect(existsSync(other.source_path)).toBe(false);
  } finally { server.stop(); history.close(); }
});

test("ordinary managed Canvas servers do not expose the cross-project gallery API", async () => {
  const dir = tempDir();
  const server = await createCanvasServer({ canvasesDir: dir, historyPath: join(dir, "history.sqlite") });
  try { expect((await fetch(`${server.url}/api/gallery?all=1`)).status).toBe(404); }
  finally { server.stop(); }
});

test("CLI web starts a local gallery and shuts down on SIGTERM", async () => {
  const dir = tempDir();
  writeCanvas(dir, "working", VALID_CANVAS);
  const child = Bun.spawn([process.execPath, join(PLUGIN_ROOT, "src/cli.ts"), "web", "--port", "0", "--dir", dir, "--history-db", join(dir, "history.sqlite")], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const started = async () => {
      let output = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`web exited before listening: ${output}`);
        output += new TextDecoder().decode(chunk.value);
        try { return JSON.parse(output) as { ok: boolean; url: string }; } catch { /* Wait for a complete JSON startup message. */ }
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([started(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("web startup timed out")), 10_000); })]).finally(() => clearTimeout(timeout));
    expect(ready.ok).toBe(true);
    expect((await fetch(ready.url)).status).toBe(200);
    expect((await (await fetch(`${ready.url}/api/gallery`)).json() as GalleryData).artifacts[0]?.name).toBe("working");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await expect(fetch(ready.url)).rejects.toThrow();
    reader.releaseLock();
  } finally { child.kill(); await child.exited; }
}, { timeout: 15_000 });
