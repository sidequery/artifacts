import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("empty hosted library supplies copyable deployment MCP URL and starter prompt", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (path === "/api/session") return Response.json({});
    if (path === "/api/gallery") return Response.json({ workspace: "my-project", artifacts: [], capabilities: { links: true, scripts: true } });
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.goto(new URL("?library=team", server.url).href);
    const url = await page.getByLabel("Deployment MCP URL").inputValue();
    expect(url).toBe(new URL("/mcp?workspace=my-project&library=team", server.url).href);
    await page.getByRole("button", { name: "Copy MCP URL", exact: true }).click();
    await page.getByText("MCP URL copied", { exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    const prompt = await page.getByLabel("Starter prompt").inputValue();
    expect(prompt).toContain("artifact_guide");
    expect(prompt).toContain("private access");
    await page.getByRole("button", { name: "Copy starter prompt", exact: true }).click();
    await page.getByText("Starter prompt copied", { exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
