import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

test("owned file editor saves inside an allow-scripts sandbox and preserves conflicts", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".file-editor-test-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  try {
    const entrypoint = join(directory, "entry.tsx");
    await Bun.write(entrypoint, `
      import { mountArtifactFileEditor } from '../../src/runtime/mcp-file-editor';
      const uri = 'host-owned:opaque-token';
      let text = 'export default "initial";';
      let etag = 'v1';
      window.fileWrites = [];
      window.fileOutcome = 'saved';
      const resources = {
        addUpdateHandler(handler) { window.fileUpdate = () => handler({params:{uri}}); return () => {}; },
        async subscribe() { return {}; }, async unsubscribe() { return {}; },
        async read() { return {contents:[{uri,text,openaiMetadata:{writable:true,etag}}]}; },
        async write(writeUri, value) {
          window.fileWrites.push({uri:writeUri,...value});
          if (window.fileOutcome === 'conflict') return {outcome:'conflict',etag:'external'};
          text = value.text; etag = 'v2'; return {outcome:'saved',etag};
        }
      };
      window.fileEditor = mountArtifactFileEditor(document.getElementById('root'), {resources}, {file:{name:'demo.artifact.tsx',resourceUri:uri}});
    `);
    const build = await Bun.build({ entrypoints: [entrypoint], target: "browser" });
    expect(build.success).toBe(true);
    const js = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
      return new Response(path === "/editor" ? '<div id="root" style="height:600px"></div><script type="module" src="/client.js"></script>' : '<iframe title="File editor" sandbox="allow-scripts" src="/editor" style="width:900px;height:650px"></iframe>', { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const frame = page.frameLocator('iframe');
    const editor = frame.getByRole("textbox", { name: "demo.artifact.tsx", exact: true });
    await editor.waitFor();
    const save = frame.getByRole("button", { name: "Save", exact: true });
    expect(await save.isDisabled()).toBe(true);
    await editor.fill('export default "changed";');
    await save.click();
    await frame.getByText("Saved.", { exact: true }).waitFor();
    const sandbox = page.frames().find(value => value.url().endsWith("/editor"))!;
    expect(await sandbox.evaluate(() => (window as any).fileWrites)).toEqual([{ uri: "host-owned:opaque-token", text: 'export default "changed";', ifMatch: "v1" }]);
    await editor.fill('export default "keyboard";');
    await editor.press("ControlOrMeta+s");
    await frame.getByText("Saved.", { exact: true }).waitFor();
    expect(await sandbox.evaluate(() => (window as any).fileWrites.length)).toBe(2);
    await sandbox.evaluate(() => { (window as any).fileOutcome = "conflict"; });
    await editor.fill('export default "my draft";');
    await save.click();
    await frame.getByText(/The file changed in the host/).waitFor();
    expect(await editor.innerText()).toContain("my draft");
    expect(await save.isDisabled()).toBe(true);
    await frame.getByRole("button", { name: "Discard draft and reload", exact: true }).click();
    await frame.getByText("No unsaved changes", { exact: true }).waitFor();
    expect(await editor.innerText()).toContain("keyboard");
    await sandbox.evaluate(() => (window as any).fileEditor.dispose());
    expect(await frame.getByRole("textbox").count()).toBe(0);
  } finally {
    await browser?.close();
    server?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
