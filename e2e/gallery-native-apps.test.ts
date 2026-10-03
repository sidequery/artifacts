import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { galleryHtml } from "../src/gallery/server";

test("Worker gallery deploys drafts, manages revisions/secrets and preserves edit base across status refresh", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const calls: { name: string; arguments: Record<string, any> }[] = [];
  const firstToken = "a".repeat(64), newerToken = "b".repeat(64), revision = "c".repeat(64);
  const restoredToken = "d".repeat(64);
  let saved: Record<string, any> | null = null;
  let failFirst = true;
  let failRestore = true;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/gallery.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "test", artifacts: [], libraryScope: "private", capabilities: { links: true, nativeApps: true } });
    if (url.pathname === "/api/tools") {
      const call = await request.json() as typeof calls[number]; calls.push(call);
      const result = (structuredContent: unknown, isError = false) => Response.json({ structuredContent, isError });
      switch (call.name) {
        case "app_list": return result({ apps: saved ? [saved] : [], providers: ["cloudflare"], next_offset: null });
        case "app_write": {
          saved = { name: call.arguments.name, provider: "cloudflare", status: "active", desired_revision: revision, active_revision: revision,
            revision_token: firstToken, source: call.arguments.source, manifest: call.arguments.manifest, project: call.arguments.project };
          if (failFirst) { failFirst = false; saved.status = "draft"; return result({ ...saved, applied: true, ok: false, diagnostics: [{ severity: "error", message: "Invalid fixture draft" }] }, true); }
          return result({ ...saved, applied: true, ok: true });
        }
        case "app_read": return result(saved);
        case "app_history": return result({ revisions: [{ id: revision, created_at: "2026-10-03T00:00:00Z" }], next_offset: null });
        case "app_reconcile": return result({ ...saved, ok: true });
        case "app_secrets": return result({ names: ["TOKEN"] });
        case "app_restore": {
          if (failRestore) {
            failRestore = false;
            saved = { ...saved, source: 'export default {fetch(){return new Response("restored draft");}};', revision_token: restoredToken, status: "recovery-required" };
            return result({ ...saved, applied: true, ok: false, diagnostics: [{ severity: "error", message: "Missing restored secret" }] }, true);
          }
          return result({ ...saved, ok: true });
        }
        default: throw new Error(`Unexpected gallery tool ${call.name}`);
      }
    }
    return new Response(galleryHtml(), { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Worker apps", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Worker apps" });
    await panel.getByText("No Worker apps saved.").waitFor();
    await panel.getByLabel("Worker app name").fill("example");
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Invalid fixture draft" }).waitFor();
    expect(calls.find(call => call.name === "app_write")!.arguments.expected_revision).toBeNull();
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByText("Worker app deployed", { exact: true }).waitFor();
    expect(calls.filter(call => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(firstToken);
    expect(await panel.getByRole("link", { name: "Open private app" }).getAttribute("href")).toBe("/apps/example/?workspace=test");
    // Another editor saves a newer project after this panel loaded the first token.
    saved!.revision_token = newerToken;
    await panel.locator(".cm-content").fill('export default {fetch(){return new Response("local edit");}};');
    await panel.getByRole("button", { name: "Reconcile deployment", exact: true }).click();
    await panel.getByText("Deployment reconciled", { exact: true }).waitFor();
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    await panel.getByLabel("Secret name", { exact: true }).fill("TOKEN");
    await panel.getByLabel("Secret value", { exact: true }).fill("secret-fixture-value");
    await panel.getByRole("button", { name: "Save secret", exact: true }).click();
    await panel.getByText("Secret saved", { exact: true }).waitFor();
    expect(await panel.getByLabel("Secret value", { exact: true }).inputValue()).toBe("");
    expect(await panel.locator(".cm-content").innerText()).toContain("local edit");
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByText("Worker app deployed", { exact: true }).waitFor();
    expect(calls.filter(call => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(firstToken);
    await panel.getByRole("button", { name: "Restore Worker revision", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Missing restored secret" }).waitFor();
    expect(await panel.locator(".cm-content").innerText()).toContain("restored draft");
    expect(await panel.getByText("Unsaved changes", { exact: true }).count()).toBe(0);
    await panel.getByRole("button", { name: "Save and deploy Worker", exact: true }).click();
    await panel.getByText("Worker app deployed", { exact: true }).waitFor();
    expect(calls.filter(call => call.name === "app_write").at(-1)!.arguments.expected_revision).toBe(restoredToken);
    expect(calls.filter(call => call.name === "app_write").at(-1)!.arguments.source).toContain("restored draft");
    await panel.getByRole("button", { name: "Restore Worker revision", exact: true }).click();
    await panel.getByText("Source restored and deployed; data retained", { exact: true }).waitFor();
    expect(calls.find(call => call.name === "app_restore")!.arguments.revision_id).toBe(revision);
    if (process.env.GALLERY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GALLERY_SCREENSHOT_DIR}/native-apps.png`, fullPage: true });
    await panel.getByRole("button", { name: "Close Worker apps", exact: true }).click();
    expect(await panel.count()).toBe(0); expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
