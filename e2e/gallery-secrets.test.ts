import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { galleryHtml } from "../src/gallery/server";
import type { GalleryArtifact } from "../src/gallery/types";

test("gallery exposes server secret names and writes for artifacts and scripts without retaining values", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const artifacts: GalleryArtifact[] = [
    { key: "artifact:app", name: "app", workspace: "default", working: true, versions: [] },
    { key: "script:handler", kind: "script", name: "handler", workspace: "default", working: true, versions: [] },
  ];
  const calls: { name: string; arguments: { name: string; secrets?: Record<string, string | null> } }[] = [];
  const secrets: Record<string, Record<string, string>> = { app: { EXISTING: "hidden-fixture-value" }, handler: { EXISTING: "hidden-fixture-value" } };
  let hosted = true;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/gallery.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts, ...(hosted ? { capabilities: { scripts: true, links: true } } : {}) });
    if (url.pathname === "/gallery/preview") return new Response("<p>Artifact preview</p>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/source") return Response.json({ source: "export default {};", server_source: null, project: { files: {}, dependencies: {}, lock: {} } });
    if (url.pathname === "/api/tools") {
      const call = await request.json() as typeof calls[number]; calls.push(call);
      expect(call.name).toBe(`${call.arguments.name === "app" ? "artifact" : "script"}_secrets`);
      if (call.arguments.secrets) for (const [key, value] of Object.entries(call.arguments.secrets)) {
        if (value === null) delete secrets[call.arguments.name]![key];
        else secrets[call.arguments.name]![key] = value;
      }
      return Response.json({ structuredContent: { ok: true, names: Object.keys(secrets[call.arguments.name]!).sort() } });
    }
    return new Response(galleryHtml(), { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    for (const [name, label, kind] of [["app", "app", "artifact"], ["handler", "handler Script", "script"]] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Load secret names", exact: true }).click();
      await page.getByLabel("Secret names").getByText("EXISTING", { exact: true }).waitFor();
      expect(await page.locator("body").innerText()).not.toContain("hidden-fixture-value");
      await page.getByLabel("Secret name", { exact: true }).fill("TOKEN");
      await page.getByLabel("Secret value", { exact: true }).fill("typed-fixture-value");
      expect(await page.getByLabel("Secret value", { exact: true }).getAttribute("type")).toBe("password");
      await page.getByRole("button", { name: "Save secret", exact: true }).click();
      await page.getByText("Secret saved", { exact: true }).waitFor();
      expect(await page.getByLabel("Secret value", { exact: true }).inputValue()).toBe("");
      expect(calls.at(-1)).toEqual({ name: `${kind}_secrets`, arguments: { name, secrets: { TOKEN: "typed-fixture-value" } } });
      if (kind === "artifact" && process.env.GALLERY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GALLERY_SCREENSHOT_DIR}/artifact-secrets.png`, fullPage: true });
      await page.getByRole("button", { name: "Remove secret", exact: true }).click();
      await page.getByText("Secret removed", { exact: true }).waitFor();
      expect(calls.at(-1)).toEqual({ name: `${kind}_secrets`, arguments: { name, secrets: { TOKEN: null } } });
    }
    expect(errors).toEqual([]);
    hosted = false;
    await page.reload();
    await page.getByRole("button", { name: "app", exact: true }).click();
    expect(await page.getByRole("tablist", { name: "Artifact view" }).getByRole("tab", { name: "Settings", exact: true }).count()).toBe(0);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
