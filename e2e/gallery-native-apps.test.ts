import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { galleryHtml } from "../src/gallery/server";

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
    await page.getByRole("button", { name: "Worker apps", exact: true }).click();
    const panel = page.getByRole("region", { name: "Worker apps", exact: true });
    await panel.getByText("No Worker apps saved.").waitFor();
    await panel.getByRole("button", { name: "New Worker app", exact: true }).click();
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
    await panel.getByRole("button", { name: "Back to gallery", exact: true }).click();
    expect(await panel.count()).toBe(0);
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
    expect(await panel.getByRole("button", { name: "New Worker app", exact: true }).isDisabled()).toBe(true);
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
