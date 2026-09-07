import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("gallery and standalone frame bridge requires enablement and accepts only its parent response", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/runtime/gallery-request.ts", import.meta.url).pathname], target: "browser", format: "iife" });
  expect(build.success).toBe(true);
  const bridge = await build.outputs[0]!.text();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><html><body></body></html>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.setContent('<iframe id="canvas" sandbox="allow-scripts"></iframe><iframe id="other" sandbox="allow-scripts"></iframe>');
    await page.evaluate(bridge => {
      window.addEventListener("message", event => {
        const frame = document.querySelector<HTMLIFrameElement>("#canvas")!;
        if (event.source !== frame.contentWindow || event.data?.type !== "canvas/plugin-request") return;
        // A sibling's forged response has the right ID but the wrong source.
        document.querySelector<HTMLIFrameElement>("#other")!.contentWindow!.postMessage(event.data, "*");
        setTimeout(() => frame.contentWindow!.postMessage({ type: "canvas/plugin-response", id: event.data.id, result: event.data.request.input }, "*"), 100);
      });
      document.querySelector<HTMLIFrameElement>("#other")!.srcdoc = `<script>onmessage=e=>parent.frames[0].postMessage({type:'canvas/plugin-response',id:e.data.id,result:'forged'},'*')<\/script>`;
      document.querySelector<HTMLIFrameElement>("#canvas")!.srcdoc = `<button>Call</button><p>idle</p><script>window.__herdrCanvas={plugins:true};${bridge.replace(/<\/script/gi, "<\\/script")}document.querySelector('button').onclick=()=>window.__herdrCanvas.onPluginCall({plugin:'directory',operation:'lookup',input:'verified'}).then(result=>document.querySelector('p').textContent=result);<\/script>`;
    }, bridge);
    const frame = page.frameLocator("#canvas");
    await frame.getByRole("button").click();
    await frame.getByText("verified", { exact: true }).waitFor();
    await page.locator("#canvas").evaluate((element, bridge) => {
      (element as HTMLIFrameElement).srcdoc = `<p></p><script>window.__herdrCanvas={plugins:false};${bridge.replace(/<\/script/gi, "<\\/script")}document.querySelector('p').textContent=typeof window.__herdrCanvas.onPluginCall;<\/script>`;
    }, bridge);
    await frame.getByText("undefined", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
