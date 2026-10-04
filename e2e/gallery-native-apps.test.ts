import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { galleryHtml } from "../src/gallery/server";

test("Workers share the library folders, search, selection and mobile navigation with artifacts and scripts", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const calls: { workspace: string; name: string; arguments: Record<string, unknown> }[] = [];
  const workers = ["default", "Jobs"].map(workspace => ({
    key: JSON.stringify(["worker", workspace, "example"]), workspace, kind: "worker", name: "example", provider: "cloudflare", status: "active", revision_token: "a".repeat(64),
  }));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/gallery.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({
      workspace: "default", capabilities: { scripts: true, links: true, nativeApps: true }, nativeAppProviders: ["cloudflare"],
      artifacts: url.searchParams.has("offset") ? [] : [
        { key: "report", name: "Report", workspace: "default", working: true, versions: [] },
        { key: "sync", kind: "script", name: "sync", workspace: "default", working: true, versions: [] },
      ],
      workerApps: [workers[url.searchParams.has("offset") ? 1 : 0]], nextOffset: url.searchParams.has("offset") ? null : 100,
    });
    if (url.pathname === "/api/source") return Response.json({ source: "export default function Report() { return <h1>Report</h1>; }", project: { files: {}, dependencies: {}, lock: {} } });
    if (url.pathname === "/gallery/preview") return new Response("<h1>Report</h1>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/tools") {
      const call = await request.json() as { name: string; arguments: Record<string, unknown> };
      const workspace = url.searchParams.get("workspace")!;
      calls.push({ workspace, ...call });
      if (call.name === "app_read") return Response.json({ structuredContent: {
        ...workers.find(worker => worker.workspace === workspace), source: `export default { fetch() { return new Response("${workspace}"); } };`,
        manifest: { main: "worker.ts", compatibility_date: "2026-09-06" }, project: { files: {}, dependencies: {}, lock: {} },
      } });
      if (call.name === "app_history") return Response.json({ structuredContent: { revisions: [], next_offset: null } });
      throw new Error(`Unexpected tool ${call.name}`);
    }
    return new Response(galleryHtml(), { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    const library = page.getByRole("complementary");
    const worker = library.getByTitle("Jobs/example", { exact: true });
    const otherWorker = library.getByTitle("default/example", { exact: true });
    const report = library.getByTitle("default/Report", { exact: true });
    await worker.waitFor();
    expect(await otherWorker.isVisible()).toBe(true);
    expect(await library.getByTitle("default/sync", { exact: true }).isVisible()).toBe(true);
    const search = library.getByRole("searchbox", { name: "Search library" });
    await search.fill("Jobs");
    await otherWorker.waitFor({ state: "hidden" });
    expect(await worker.isVisible()).toBe(true);
    expect(await report.count()).toBe(0);
    await search.fill("");
    const filters = library.getByRole("group", { name: "Filter library" });
    await filters.getByRole("button", { name: "Workers", exact: true }).click();
    expect(await report.count()).toBe(0);
    expect(await library.locator(".artifact-row").count()).toBe(2);
    await filters.getByRole("button", { name: "All", exact: true }).click();
    // An artifact draft survives opening and closing a Worker in the same detail pane.
    await report.click();
    await page.getByRole("tab", { name: "Source", exact: true }).click();
    const artifactSource = page.getByRole("textbox", { name: "Report.artifact.tsx", exact: true });
    await artifactSource.fill("export default function Report() { return <h1>Unsaved report</h1>; }");
    await worker.click();
    const panel = page.getByRole("region", { name: "Worker apps", exact: true });
    const source = panel.getByRole("textbox", { name: "worker.ts", exact: true });
    await source.waitFor();
    expect(await source.innerText()).toContain('"Jobs"');
    expect(await library.isVisible()).toBe(true);
    expect(await worker.getAttribute("aria-current")).toBe("true");
    expect(await otherWorker.getAttribute("aria-current")).toBeNull();
    expect(await report.getAttribute("aria-current")).toBeNull();
    expect(await page.locator(".gallery-layout > .artifact-detail").count()).toBe(1);
    expect(calls.filter(call => call.name === "app_read").at(-1)?.workspace).toBe("Jobs");
    if (process.env.GALLERY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GALLERY_SCREENSHOT_DIR}/worker-shared-library.png`, fullPage: true });
    await source.fill('export default { fetch() { return new Response("unsaved worker"); } };');
    page.once("dialog", dialog => dialog.dismiss());
    await report.click();
    expect(await source.innerText()).toContain("unsaved worker");
    expect(new URL(page.url()).searchParams.get("app")).toBe("example");
    page.once("dialog", dialog => dialog.accept());
    await report.click();
    await artifactSource.waitFor();
    expect(await artifactSource.innerText()).toContain("Unsaved report");
    await page.goBack();
    await source.waitFor();
    expect(await source.innerText()).toContain('"Jobs"');
    await otherWorker.click();
    await page.waitForFunction(() => document.querySelector('.worker-workspace .cm-content')?.textContent?.includes('"default"'));
    expect(new URL(page.url()).searchParams.get("workspace")).toBe("default");
    await page.reload();
    await source.waitFor();
    expect(await otherWorker.getAttribute("aria-current")).toBe("true");
    await page.setViewportSize({ width: 390, height: 844 });
    await source.fill('export default { fetch() { return new Response("mobile draft"); } };');
    await panel.getByRole("button", { name: "Back to library", exact: true }).click();
    await library.waitFor();
    expect(await otherWorker.evaluate(element => element === document.activeElement)).toBe(true);
    await otherWorker.click();
    await panel.waitFor();
    expect(await source.innerText()).toContain("mobile draft");
    expect(await panel.getByRole("link", { name: "Open private app" }).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(calls.every(call => ["app_read", "app_history"].includes(call.name))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30000);

test("Worker gallery deploys drafts, manages revisions/secrets and preserves edit base across status refresh", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname],
    target: "browser",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const calls: { name: string; arguments: Record<string, any> }[] = [];
  const firstToken = "a".repeat(64),
    newerToken = "b".repeat(64),
    revision = "c".repeat(64);
  const restoredToken = "d".repeat(64);
  let saved: Record<string, any> | null = null;
  let failFirst = true;
  let failRestore = true;
  let failReconcile = true;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/gallery.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/session") return Response.json({});
      if (url.pathname === "/api/gallery")
        return Response.json({
          workspace: "test",
          artifacts: [],
          workerApps: saved ? [{ ...saved, key: "worker-example", kind: "worker", workspace: "test" }] : [],
          nativeAppProviders: ["cloudflare"],
          libraryScope: "private",
          capabilities: { links: true, nativeApps: true },
        });
      if (url.pathname === "/api/tools") {
        const call = (await request.json()) as (typeof calls)[number];
        calls.push(call);
        const result = (structuredContent: unknown, isError = false) => Response.json({ structuredContent, isError });
        switch (call.name) {
          case "app_list":
            return result({ apps: saved ? [saved] : [], providers: ["cloudflare"], next_offset: null });
          case "app_write": {
            if (saved && call.arguments.expected_revision !== saved.revision_token)
              return result(
                { ok: false, diagnostics: [{ severity: "error", message: "Revision conflict: reload before saving" }] },
                true,
              );
            saved = {
              name: call.arguments.name,
              provider: "cloudflare",
              status: "active",
              desired_revision: revision,
              active_revision: revision,
              revision_token: firstToken,
              source: call.arguments.source,
              manifest: call.arguments.manifest,
              project: call.arguments.project,
            };
            if (failFirst) {
              failFirst = false;
              saved.status = "draft";
              return result(
                {
                  ...saved,
                  applied: true,
                  ok: false,
                  diagnostics: [{ severity: "error", message: "Invalid fixture draft" }],
                },
                true,
              );
            }
            return result({ ...saved, applied: true, ok: true });
          }
          case "app_read":
            return result(saved);
          case "app_history":
            return result({ revisions: [{ id: revision, created_at: "2026-10-03T00:00:00Z" }], next_offset: null });
          case "app_reconcile":
            if (failReconcile) {
              failReconcile = false;
              saved!.status = "recovery-required";
              return result(
                {
                  ...saved,
                  applied: true,
                  ok: false,
                  diagnostics: [{ severity: "error", message: "Deployment temporarily unavailable" }],
                },
                true,
              );
            }
            saved!.status = "active";
            return result({ ...saved, ok: true });
          case "app_secrets":
            return result({ names: ["TOKEN"] });
          case "app_move":
            saved = null;
            return result({ ok: true });
          case "app_restore": {
            if (failRestore) {
              failRestore = false;
              saved = {
                ...saved,
                source: 'export default {fetch(){return new Response("restored draft");}};',
                revision_token: restoredToken,
                status: "recovery-required",
              };
              return result(
                {
                  ...saved,
                  applied: true,
                  ok: false,
                  diagnostics: [{ severity: "error", message: "Missing restored secret" }],
                },
                true,
              );
            }
            return result({ ...saved, ok: true });
          }
          default:
            throw new Error(`Unexpected gallery tool ${call.name}`);
        }
      }
      return new Response(galleryHtml(), { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    const library = page.getByRole("complementary");
    expect(await page.locator(".header-actions").getByRole("button", { name: "Worker apps", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Create or import", exact: true }).click();
    await page.getByRole("menuitem", { name: "New Worker app", exact: true }).click();
    const panel = page.getByRole("region", { name: "Worker apps", exact: true });
    expect(await library.isVisible()).toBe(true);
    await panel.getByLabel("Worker app name").fill("example");
    await panel.getByRole("button", { name: "Continue to editor" }).click();
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await panel.getByText("Advanced manifest (JSON)", { exact: true }).click();
    const fullManifest = {
      main: "worker.ts",
      compatibility_date: "2026-09-06",
      compatibility_flags: ["nodejs_compat"],
      vars: { STAGE: "dev" },
      secrets: ["TOKEN"],
      bindings: {
        STORE: { type: "kv", resource: "store" },
        ROOM: { type: "durable-object", resource: "rooms", class_name: "Room" },
        JOBS: { type: "queue", resource: "jobs" },
      },
      triggers: { crons: ["0 * * * *"], queues: ["jobs"] },
    };
    await panel.getByLabel("Worker app manifest").fill(JSON.stringify(fullManifest));
    await panel.getByLabel("Variable value 1", { exact: true }).fill("production");
    await panel.getByRole("tab", { name: "Resources", exact: true }).click();
    await panel.getByLabel("Resource name 1", { exact: true }).fill("stable_store");
    await panel.getByRole("tab", { name: "Triggers", exact: true }).click();
    await panel.getByLabel("Cron schedule 1", { exact: true }).fill("30 * * * *");
    await panel.getByRole("tab", { name: "Source", exact: true }).click();
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Invalid fixture draft" }).waitFor();
    expect(calls.find((call) => call.name === "app_write")!.arguments.expected_revision).toBeNull();
    expect(calls.find((call) => call.name === "app_write")!.arguments.manifest).toEqual({
      ...fullManifest,
      vars: { STAGE: "production" },
      bindings: { ...fullManifest.bindings, STORE: { type: "kv", resource: "stable_store" } },
      triggers: { crons: ["30 * * * *"], queues: ["jobs"] },
    });
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByText("Worker app deployed", { exact: true }).waitFor();
    await library.getByTitle("test/example", { exact: true }).waitFor();
    expect(await library.getByTitle("test/example", { exact: true }).getAttribute("aria-current")).toBe("true");
    expect(calls.filter((call) => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(firstToken);
    expect(await panel.getByRole("link", { name: "Open private app" }).getAttribute("href")).toBe(
      "/apps/example/?workspace=test",
    );
    // Another editor saves a newer project after this panel loaded the first token.
    saved!.revision_token = newerToken;
    await panel.locator(".cm-content").fill('export default {fetch(){return new Response("local edit");}};');
    await panel.getByText("Unsaved changes", { exact: true }).waitFor();
    await page.evaluate(() => {
      const workerUrl = window.location.href;
      window.history.replaceState(null, "", "/?workspace=test");
      window.history.pushState(null, "", workerUrl);
    });
    const declinedBack = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
    await page.evaluate(() => window.history.back());
    await declinedBack;
    await panel.getByRole("tab", { name: "Source", exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get("view")).toBe("workers");
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    await panel.getByRole("tab", { name: "Deployments", exact: true }).click();
    await panel.getByRole("button", { name: "Reconcile deployment", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Deployment temporarily unavailable" }).waitFor();
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    expect(await panel.getByText("Unsaved changes", { exact: true }).count()).toBe(1);
    await panel.getByRole("button", { name: "Retry deployment", exact: true }).click();
    await panel.getByText("Deployment reconciled", { exact: true }).waitFor();
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    expect(new URL(page.url()).searchParams.get("app")).toBe("example");
    expect(new URL(page.url()).searchParams.get("appTab")).toBe("deployments");
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await panel.getByLabel("Secret name", { exact: true }).fill("TOKEN");
    await panel.getByLabel("Secret value", { exact: true }).fill("secret-fixture-value");
    const writesBeforeSecret = calls.filter((call) => call.name === "app_write").length;
    await panel.getByRole("button", { name: "Save secret", exact: true }).click();
    await panel.getByText("Secret saved", { exact: true }).waitFor();
    expect(await panel.getByLabel("Secret value", { exact: true }).inputValue()).toBe("");
    expect(calls.filter((call) => call.name === "app_write").length).toBe(writesBeforeSecret);
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Revision conflict" }).waitFor();
    expect(calls.filter((call) => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(firstToken);
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    expect(await panel.getByText("Unsaved changes", { exact: true }).count()).toBe(1);
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("tab", { name: "Deployments", exact: true }).click();
    await panel.getByRole("button", { name: "Restore and deploy", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Missing restored secret" }).waitFor();
    expect(await panel.locator(".cm-content").innerText()).toContain("restored draft");
    expect(await panel.getByText("Unsaved changes", { exact: true }).count()).toBe(0);
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByText("Worker app deployed", { exact: true }).waitFor();
    expect(calls.filter((call) => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(restoredToken);
    expect(calls.filter((call) => call.name === "app_write").at(-1)!.arguments.source).toContain("restored draft");
    await panel.getByRole("tab", { name: "Deployments", exact: true }).click();
    await panel.getByRole("button", { name: "Restore and deploy", exact: true }).click();
    await panel.getByText("Source restored and deployed; data retained", { exact: true }).waitFor();
    expect(calls.find((call) => call.name === "app_restore")!.arguments.revision_id).toBe(revision);
    if (process.env.GALLERY_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.GALLERY_SCREENSHOT_DIR}/native-apps-deployments-wide.png`,
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await panel.getByRole("button", { name: "Save secret", exact: true }).scrollIntoViewIfNeeded();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await panel.getByRole("tab", { name: "Deployments", exact: true }).click();
    await panel.getByRole("button", { name: "Restore and deploy", exact: true }).scrollIntoViewIfNeeded();
    await panel.getByRole("tab", { name: "Source", exact: true }).click();
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).scrollIntoViewIfNeeded();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (process.env.GALLERY_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.GALLERY_SCREENSHOT_DIR}/native-apps.png`, fullPage: true });
    await panel.getByRole("button", { name: "Back to library", exact: true }).click();
    await library.waitFor();
    expect(await panel.isVisible()).toBe(false);
    await library.getByTitle("test/example", { exact: true }).click();
    await panel.waitFor();
    await panel.getByRole("tab", { name: "Settings", exact: true }).click();
    await panel.getByRole("button", { name: "Move to team library", exact: true }).click();
    await library.waitFor();
    await library.getByTitle("test/example", { exact: true }).waitFor({ state: "hidden" });
    expect(await panel.count()).toBe(0);
    expect(new URL(page.url()).searchParams.get("view")).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30000);

test("Worker provider empty state has documentation and no creation editor", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname],
    target: "browser",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/gallery.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/session") return Response.json({});
      if (url.pathname === "/api/gallery")
        return Response.json({
          workspace: "test",
          artifacts: [],
          workerApps: [{ key: "unavailable-app", kind: "worker", workspace: "test", name: "unavailable-app", provider: "cloudflare", status: "active", revision_token: "a".repeat(64) }],
          nativeAppProviders: [],
          libraryScope: "private",
          capabilities: { nativeApps: true },
        });
      if (url.pathname === "/api/tools") {
        const call = (await request.json()) as { name: string };
        const saved = {
          name: "unavailable-app",
          provider: "cloudflare",
          status: "active",
          revision_token: "a".repeat(64),
          source: "export default {};",
          manifest: { main: "worker.ts", compatibility_date: "2026-09-06" },
          project: { files: {}, dependencies: {} },
        };
        if (call.name === "app_read") return Response.json({ structuredContent: saved });
        if (call.name === "app_history")
          return Response.json({ structuredContent: { revisions: [], next_offset: null } });
        return Response.json({ structuredContent: { apps: [saved], providers: [], next_offset: null } });
      }
      return new Response(galleryHtml(), { headers: { "content-type": "text/html" } });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.url.href}?workspace=test&library=team&view=workers`);
    const panel = page.getByRole("region", { name: "Worker apps", exact: true });
    await panel.getByRole("heading", { name: "Worker apps are unavailable" }).waitFor();
    expect(await panel.getByRole("link", { name: "Worker setup documentation" }).getAttribute("href")).toBe(
      "https://github.com/sidequery/artifacts/blob/main/docs/native-workers.md",
    );
    expect(await panel.getByLabel("Worker app name").count()).toBe(0);
    expect(await panel.locator(".cm-content").count()).toBe(0);
    await page.goto(`${server.url.href}?workspace=test&library=team&view=workers&app=unavailable-app&appTab=source`);
    await panel
      .getByText(
        "unavailable-app uses cloudflare, which is not available on this deployment. Configure that provider to edit or deploy this app.",
      )
      .waitFor();
    expect(await panel.locator(".cm-content").count()).toBe(0);
    expect(await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).count()).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30000);
