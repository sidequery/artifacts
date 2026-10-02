import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GalleryArtifact } from "../src/gallery/types";

test("gallery edits scripts without execution and runs requests only on demand", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const js = await build.outputs[0]!.text();
  const artifacts: GalleryArtifact[] = [{ key: "script:hello", kind: "script", name: "hello", workspace: "default", working: true, versions: [], slug: "hello", url: "/hello", access: "private" }];
  let hosted = true;
  const calls: { name: string; arguments: Record<string, any> }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts: hosted ? artifacts : [{ key: "local", name: "local", workspace: "default", working: true, versions: [] }], ...(hosted ? { capabilities: { scripts: true, links: true } } : {}) });
    if (url.pathname === "/gallery/preview") return new Response("<p>Artifact preview</p>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/source") {
      const source = 'export default { fetch() { return new Response("hello"); } };';
      return url.searchParams.get("format") === "json"
        ? Response.json({ source, project: { files: {}, dependencies: {}, lock: {} } })
        : new Response(source);
    }
    if (url.pathname === "/api/tools") {
      const call = await request.json() as typeof calls[number]; calls.push(call);
      if (call.name === "script_write" && call.arguments.name !== "hello") artifacts.push({ key: "script:new", kind: "script", name: call.arguments.name, workspace: "default", working: true, versions: [] });
      if (call.name === "script_remix") artifacts.push({key:"script:remixed",kind:"script",name:call.arguments.new_name,workspace:"default",working:true,versions:[]});
      if (call.name === "artifact_link") return Response.json({ error: "Slug is already in use" }, { status: 409 });
      return Response.json({ structuredContent: { response: { status: 200, statusText: "OK", headers: [["content-type", "text/plain"]], body: Buffer.from("<script>alert(1)</script> 🌍").toString("base64") } } });
    }
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const screenshot = async (name: string) => { const directory = process.env.GALLERY_SCREENSHOT_DIR; if (directory) { await mkdir(directory, { recursive: true }); await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true }); } };
    await page.goto(server.url.href);
    await page.getByRole("textbox", { name: "script.ts", exact: true }).waitFor();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(calls).toEqual([]);
    await page.getByRole("textbox", { name: "script.ts", exact: true }).fill('export default { fetch() { return new Response("changed"); } };');
    const views = page.getByRole("group", { name: "Script view" });
    const sourceDimensions = await page.locator(".source-code-surface:visible").evaluate(el => ({ editor: el.getBoundingClientRect().height, pane: el.closest(".artifact-detail")!.getBoundingClientRect().height }));
    expect(sourceDimensions.editor).toBeGreaterThan(sourceDimensions.pane / 2);
    await screenshot("gallery-script-source");
    await views.getByRole("button", { name: "Requests", exact: true }).click();
    await views.getByRole("button", { name: "Source", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "script.ts", exact: true }).innerText()).toContain('new Response("changed")');
    await page.getByRole("button", { name: "Save and deploy", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Script saved" }).waitFor();
    expect(calls.map(call => call.name)).toEqual(["script_write"]);
    await views.getByRole("button", { name: "Requests", exact: true }).click();
    await page.getByRole("combobox", { name: "Request method" }).selectOption("POST");
    await page.getByRole("textbox", { name: "Request body" }).fill("hello 🌍");
    await page.getByRole("textbox", { name: "Request headers" }).fill('{"content-type":"text/plain"}');
    await page.getByRole("button", { name: "Run script" }).click();
    await page.getByLabel("Script response").waitFor();
    await screenshot("gallery-script-request");
    expect(calls[1]?.arguments.request).toEqual({ path: "/", method: "POST", headers: [["content-type", "text/plain"]], body: Buffer.from("hello 🌍").toString("base64") });
    expect(await page.getByLabel("Script response").textContent()).toContain("200 OK\ncontent-type: text/plain\n\n<script>alert(1)</script> 🌍");
    await page.getByRole("button", { name: "Link settings", exact: true }).click();
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Slug is already in use" }).waitFor();
    await page.getByRole("button", { name: "New script" }).click();
    await page.getByRole("textbox", { name: "Script name", exact: true }).fill("new-handler");
    await page.getByRole("textbox", { name: "Script slug" }).fill("new-handler");
    await page.getByRole("button", { name: "Save and deploy", exact: true }).click();
    await page.getByRole("button", { name: "new-handler Script", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "new-handler Script", exact: true }).getAttribute("aria-current")).toBe("true");
    expect(calls.filter(call => call.name === "script_run")).toHaveLength(1);
    await page.getByRole("button", {name:"Remix",exact:true}).click();
    await page.getByRole("textbox", {name:"Remix name"}).fill("remixed-handler");
    await page.getByRole("button", {name:"Create remix",exact:true}).click();
    const remixedRow=page.getByRole("button",{name:"remixed-handler Script",exact:true});
    await remixedRow.waitFor();
    expect(await remixedRow.getAttribute("aria-current")).toBe("true");
    expect(calls.at(-1)).toEqual({name:"script_remix",arguments:{name:"new-handler",new_name:"remixed-handler"}});
    hosted = false;
    await page.reload();
    await page.getByTitle("Preview of local").waitFor();
    expect(await page.getByRole("button", { name: "New script" }).count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "URL slug" }).count()).toBe(0);
  } finally { await browser.close(); server.stop(true); }
}, 30000);

test("invalid saved drafts show live targets and clickable helper diagnostics", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const artifact = { key: "handler", kind: "script", name: "handler", workspace: "default", working: true, versions: [], live: { id: "good", revision: 1, revision_token: "good" }, draftRevision: "good" };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts: [artifact], capabilities: { links: true, scripts: true } });
    if (url.pathname === "/api/source") return Response.json({ source: "export default {};", revision_token: "good", project: { files: { "lib/value.ts": "export const value = 1;\nexport const broken = missing;\n" }, dependencies: {}, lock: {} } });
    if (url.pathname === "/api/tools") {
      artifact.draftRevision = "invalid";
      return Response.json({ isError: true, structuredContent: { applied: true, ok: false, revision_token: "invalid", diagnostics: [{ severity: "error", file: "lib/value.ts", line: 2, column: 23, message: "Cannot find name 'missing'." }] } });
    }
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.getByRole("textbox", { name: "script.ts", exact: true }).fill("invalid source");
    await page.getByRole("button", { name: "Save and deploy", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Invalid draft saved; live revision unchanged." }).waitFor();
    expect(await page.locator(".deployment-status").innerText()).toBe("Live revision 1 · Saved draft; live revision unchanged");
    await page.getByRole("button", { name: "lib/value.ts:2:23", exact: false }).click();
    const helper = page.getByRole("textbox", { name: "lib/value.ts", exact: true });
    await helper.waitFor();
    expect(await helper.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await helper.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.textContent)).toContain("export const broken");
    await page.getByText("Raw details", { exact: true }).click();
    expect(await page.locator(".save-feedback pre").innerText()).toContain('"revision_token": "invalid"');
    await page.getByRole("group", { name: "Script view" }).getByRole("button", { name: "Requests", exact: true }).click();
    expect(await page.getByText("Run target:", { exact: false }).innerText()).toContain("Live revision 1");
  } finally { await browser.close(); server.stop(true); }
}, 30000);
