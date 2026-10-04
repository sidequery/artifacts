import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("schedule loads before editing, preserves request headers and ignores unfinished fields for controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-controls-"));
  const entry = join(directory, "fixture.tsx");
  await Bun.write(entry, `import {createElement} from ${JSON.stringify(Bun.resolveSync("react", import.meta.dir))};import {createRoot} from ${JSON.stringify(Bun.resolveSync("react-dom/client", import.meta.dir))};import {ExecutionControls} from ${JSON.stringify(new URL("../src/gallery/execution-controls.tsx", import.meta.url).pathname)};createRoot(document.getElementById("root")).render(createElement(ExecutionControls,{workspace:"default",name:"example",kind:new URLSearchParams(location.search).has("unsupported")?"artifact":"script"}));`);
  let build;
  try { build = await Bun.build({ entrypoints: [entry], target: "browser" }); }
  finally { await rm(directory, { recursive: true, force: true }); }
  if (!build.success) throw new Error(build.logs.join("\n"));
  const js = await build.outputs[0]!.text();
  type Arguments = { action: string; interval_seconds?: number; request?: { path: string; method: string; headers: [string, string][]; body?: string } };
  const calls: Arguments[] = [];
  let schedule = { interval_seconds: 7200, paused: false, next_run_at: Date.now() + 7200000, request: { path: "/existing", method: "POST", headers: [["x-example", "first"], ["x-example", "second"]] as [string, string][], body: Buffer.from("prior body").toString("base64") } };
  let unsupported = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/client.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (new URL(request.url).pathname === "/api/tools") {
      const call = await request.json() as { name: string; arguments: Arguments };
      if (call.name.endsWith("_runs")) return Response.json({ structuredContent: { runs: [] } });
      if (unsupported) return Response.json({ structuredContent: { schedule: null, has_server: false } });
      calls.push(call.arguments);
      if (call.arguments.action === "get") await gate;
      if (call.arguments.action === "pause") schedule = { ...schedule, paused: true };
      if (call.arguments.action === "resume") schedule = { ...schedule, paused: false };
      if (call.arguments.action === "set") schedule = { ...schedule, interval_seconds: call.arguments.interval_seconds!, request: { ...call.arguments.request!, body: call.arguments.request!.body ?? "" } };
      return Response.json({ structuredContent: { schedule } });
    }
    return new Response('<div id="root"></div><script type="module" src="/client.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.getByText("Loading schedule…", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Save schedule", exact: true }).isEnabled()).toBe(false);
    expect(await page.getByLabel("Schedule path").isEnabled()).toBe(false);
    release();
    await page.getByText("Next run:", { exact: false }).waitFor();
    expect(await page.getByLabel("Schedule path").inputValue()).toBe("/existing");
    expect(await page.getByLabel("Schedule interval", { exact: true }).inputValue()).toBe("2");
    expect(await page.getByLabel("Schedule interval unit").inputValue()).toBe("hours");
    await page.getByText("Advanced request settings", { exact: true }).click();
    expect(await page.getByLabel("Schedule body").inputValue()).toBe("prior body");
    await page.getByLabel("Schedule interval unit").selectOption("minutes");
    expect(await page.getByLabel("Schedule interval", { exact: true }).inputValue()).toBe("120");
    await page.getByLabel("Schedule interval", { exact: true }).fill("30");
    expect(await page.getByText("Next run if saved now:", { exact: false }).innerText()).toContain("(UTC)");
    await page.getByRole("button", { name: "Save schedule", exact: true }).click();
    await page.getByRole("button", { name: "Pause schedule", exact: true }).click();
    expect(calls.find(call => call.action === "set")).toMatchObject({ interval_seconds: 1800, request: { path: "/existing", headers: [["x-example", "first"], ["x-example", "second"]] } });
    await page.getByLabel("Schedule headers").fill("{");
    await page.getByRole("button", { name: "Resume schedule", exact: true }).click();
    await page.getByRole("button", { name: "Run schedule now", exact: true }).click();
    await page.getByRole("button", { name: "Save schedule", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(calls.map(call => call.action)).toEqual(["get", "set", "pause", "resume", "run_now"]);
    await page.getByLabel("Schedule headers").fill('{"x-new":"value"}');
    await page.getByRole("button", { name: "Save schedule", exact: true }).click();
    await page.getByRole("button", { name: "Pause schedule", exact: true }).click();
    expect(calls.filter(call => call.action === "set").at(-1)!.request!.headers).toEqual([["x-new", "value"]]);
    unsupported = true;
    await page.goto(`${server.url}?unsupported=1`);
    await page.getByText("This artifact has no validated server.", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "Save schedule", exact: true }).count()).toBe(0);
    await page.getByText("No runs recorded yet.", { exact: true }).waitFor();
  } finally { release(); await browser.close(); server.stop(true); }
}, 30000);
