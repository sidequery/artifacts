import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("gallery retains complete unsaved projects and new scripts and offers conflict recovery", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/gallery/client.tsx", import.meta.url).pathname], target: "browser" });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  const token = "a".repeat(64), latestToken = "b".repeat(64);
  const artifacts = [
    { key: "report", name: "report", workspace: "default", working: true, versions: [{ id: "old", revision: 1, createdAt: "2026-09-01", reason: "edit", serveCount: 0 }] },
    { key: "handler", kind: "script", name: "handler", workspace: "default", working: true, versions: [] },
  ];
  const project = { files: { "lib/value.ts": "export const value = 1;" }, dependencies: {}, lock: {} };
  let conflict = true;
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/api/session") return Response.json({});
    if (url.pathname === "/api/gallery") return Response.json({ workspace: "default", artifacts, capabilities: { links: true, scripts: true } });
    if (url.pathname === "/api/source") return Response.json({
      source: url.searchParams.get("kind") === "script" ? "export default {};" : url.searchParams.has("version") ? "historical client" : conflict ? "saved client" : "agent client",
      server_source: url.searchParams.get("kind") === "script" ? undefined : "saved server", project, revision_token: conflict ? token : latestToken,
    });
    if (url.pathname === "/api/tools") {
      const call = await request.json() as typeof calls[number]; calls.push(call);
      if (conflict) { conflict = false; return Response.json({ error: "Project changed since it was loaded." }, { status: 409 }); }
      return Response.json({ structuredContent: { ok: true, applied: true, revision_token: "c".repeat(64) } });
    }
    if (url.pathname === "/gallery/preview") return new Response("<p>Preview</p>", { headers: { "content-type": "text/html" } });
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(server.url.href);
    await page.getByTitle("default/report", { exact: true }).click();
    await page.getByRole("tablist", { name: "Artifact view" }).getByRole("tab", { name: "Source", exact: true }).click();
    const client = page.getByRole("textbox", { name: "report.artifact.tsx", exact: true });
    await client.fill("unsaved client");
    await page.getByRole("button", { name: "report.artifact.server.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "report.artifact.server.ts", exact: true }).fill("unsaved server");
    await page.getByRole("combobox", { name: "Helper file" }).selectOption("file:lib/value.ts");
    await page.getByRole("textbox", { name: "lib/value.ts", exact: true }).fill("unsaved helper");
    await page.getByText("Dependencies (0)", { exact: true }).click();
    await page.getByRole("textbox", { name: "Project dependencies" }).fill('{"example":"latest"}');
    await page.getByTitle("default/handler", { exact: true }).click();
    await page.getByRole("textbox", { name: "script.ts", exact: true }).fill("unsaved script");
    await page.getByRole("button", { name: "Create or import", exact: true }).click();
    await page.getByRole("menuitem", { name: "New script", exact: true }).click();
    await page.getByRole("textbox", { name: "Script name", exact: true }).fill("unfinished-handler");
    await page.getByRole("textbox", { name: "script.ts", exact: true }).fill("unfinished new script");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "script.ts", exact: true }).innerText()).toBe("unsaved script");
    await page.getByRole("button", { name: "Create or import", exact: true }).click();
    await page.getByRole("menuitem", { name: "New script", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Script name", exact: true }).inputValue()).toBe("unfinished-handler");
    expect(await page.getByRole("textbox", { name: "script.ts", exact: true }).innerText()).toBe("unfinished new script");
    await page.getByTitle("default/report", { exact: true }).click();
    expect(await client.innerText()).toBe("unsaved client");
    await page.getByRole("button", { name: "report.artifact.server.ts", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "report.artifact.server.ts", exact: true }).innerText()).toBe("unsaved server");
    await page.getByRole("combobox", { name: "Helper file" }).selectOption("file:lib/value.ts");
    expect(await page.getByRole("textbox", { name: "lib/value.ts", exact: true }).innerText()).toBe("unsaved helper");
    await page.getByText("Dependencies (0)", { exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Project dependencies" }).inputValue()).toBe('{"example":"latest"}');
    expect(await page.getByRole("button", { name: "Save and deploy", exact: true }).isEnabled()).toBe(false);
    await page.getByRole("textbox", { name: "Project dependencies" }).fill("{}");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Versions", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Revision 1 ·/ }).click();
    await page.getByRole("button", { name: "Restore and deploy", exact: true }).waitFor();
    expect(await client.innerText()).toBe("historical client");
    expect(await page.locator(".live-data-note").innerText()).toContain("Historical code uses the current database and files and can change them");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Versions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Working copy", exact: true }).click();
    expect(await client.innerText()).toBe("unsaved client");
    await page.getByRole("button", { name: "Save and deploy", exact: true }).click();
    await page.getByRole("button", { name: "Compare saved project" }).waitFor();
    expect(calls[0]!.arguments).toMatchObject({ contents: "unsaved client", server: "unsaved server", expected_revision: token, project: { files: { "lib/value.ts": "unsaved helper" }, dependencies: {} } });
    await page.getByRole("button", { name: "Compare saved project" }).click();
    await page.getByText("Saved project (your edits remain in the editor)").waitFor();
    expect(await client.innerText()).toBe("unsaved client");
    await page.getByRole("button", { name: "Reload saved project" }).click();
    await page.getByRole("button", { name: "Discard edits and reload" }).click();
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="report.artifact.tsx"]')?.textContent === "agent client");
    await client.fill("merged client");
    await page.getByRole("button", { name: "Save and deploy", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Artifact saved" }).waitFor();
    expect(calls.at(-1)!.arguments.expected_revision).toBe(latestToken);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
