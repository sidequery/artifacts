import { expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createArtifactServer } from "../src/serve";
import { tempDir, writeArtifact } from "../src/test/fixtures";

test("local gallery subscribes to external file changes without refreshing unrelated previews", async () => {
  const directory = tempDir();
  const source = (text: string) => `import { H1 } from "sidequery/artifacts"; export default function App() { return <H1>${text}</H1>; }`;
  const selected = writeArtifact(directory, "alpha", source("First version"));
  const server = await createArtifactServer({ artifactsDir: directory, historyPath: join(directory, "history.sqlite"), gallery: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const connected = page.waitForEvent("websocket").then(socket => socket.waitForEvent("framereceived", { predicate: event => event.payload === "ready" }));
    await page.goto(server.url);
    await connected;
    const preview = page.frameLocator('iframe[title="Preview of alpha"]');
    await preview.getByRole("heading", { name: "First version" }).waitFor();
    expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
    expect(await page.getByPlaceholder("Search", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator(".library-heading").count()).toBe(0);
    expect(await page.locator(".scope-control").count()).toBe(0);
    expect(await page.getByText("In this project", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("img", { name: "Sidequery" }).count()).toBe(0);
    const frame = page.locator(".preview-frame");
    expect(await frame.evaluate(el => getComputedStyle(el).borderWidth)).toBe("0px");
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame.parentFrame()) navigations++; });
    const added = writeArtifact(directory, "beta", source("Second artifact"));
    await page.getByTitle(`${directory}/beta`, { exact: true }).waitFor();
    expect(navigations).toBe(0);
    writeFileSync(selected, source("Updated by another process"));
    await preview.getByRole("heading", { name: "Updated by another process" }).waitFor();
    unlinkSync(added);
    await page.getByTitle(`${directory}/beta`, { exact: true }).waitFor({ state: "hidden" });
    const rejected = await fetch(`${server.url}/api/gallery/subscribe`, { headers: { Origin: "https://untrusted.example", Upgrade: "websocket" } });
    expect(rejected.status).toBe(403);
  } finally { await browser.close(); server.stop(); }
}, 30_000);

test("live changes update clean editors, preserve dirty drafts, and reconcile after reconnect", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  let revision = "one", source = "saved source";
  const sockets = new Set<Bun.ServerWebSocket<undefined>>();
  const artifacts = [{ key: "report", name: "report", workspace: "default", working: true, versions: [] }];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1",
    websocket: {
      open(socket) { sockets.add(socket); socket.send("ready"); },
      close(socket) { sockets.delete(socket); },
      message(socket, message) { if (message === "ping") socket.send("pong"); },
    },
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/gallery/subscribe") { if (server.upgrade(request)) return; return new Response(null, { status: 426 }); }
      if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/session") return Response.json({});
      if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts: artifacts.map(item => ({ ...item, draftRevision: revision })), capabilities: { subscriptions: true, links: true } });
      if (url.pathname === "/api/source") return Response.json({ source, revision_token: revision, project: { files: {}, dependencies: {}, lock: {} } });
      if (url.pathname === "/gallery/preview") return new Response("Preview");
      return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const connected = page.waitForEvent("websocket").then(socket => socket.waitForEvent("framereceived", { predicate: event => event.payload === "ready" }));
    await page.goto(server.url.href);
    await connected;
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "report.artifact.tsx", exact: true });
    await editor.waitFor();
    source = "agent update"; revision = "two";
    for (const socket of sockets) socket.send("changed");
    await page.waitForFunction(() => document.querySelector('[aria-label="report.artifact.tsx"][role="textbox"]')?.textContent === "agent update");
    await editor.fill("my unsaved changes");
    source = "another agent update"; revision = "three";
    artifacts.push({ key: "other", name: "other", workspace: "default", working: true, versions: [] });
    for (const socket of sockets) socket.send("changed");
    await page.getByTitle("default/other", { exact: true }).waitFor();
    expect(await editor.innerText()).toBe("my unsaved changes");
    const reconnect = page.waitForEvent("websocket");
    for (const socket of sockets) socket.close(1012, "Deployment restart");
    artifacts.push({ key: "missed", name: "missed", workspace: "Reports/Monthly", working: true, versions: [] });
    await reconnect;
    const nested = page.getByTitle("Reports/Monthly/missed", { exact: true });
    await nested.waitFor();
    const reports = page.getByRole("button", { name: "Reports", exact: true });
    const monthly = page.getByRole("button", { name: "Monthly", exact: true });
    expect(await monthly.isVisible()).toBe(true);
    expect((await nested.boundingBox())!.x).toBeGreaterThanOrEqual((await monthly.boundingBox())!.x);
    await reports.click();
    expect(await nested.isVisible()).toBe(false);
    await page.getByPlaceholder("Search", { exact: true }).fill("missed");
    await nested.waitFor();
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    expect(await reports.getAttribute("aria-expanded")).toBe("false");
    await reports.click();
    await nested.click();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    await page.getByRole("textbox", { name: "missed.artifact.tsx", exact: true }).waitFor();
    await page.getByTitle("default/report", { exact: true }).click();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    expect(await editor.innerText()).toBe("my unsaved changes");
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
