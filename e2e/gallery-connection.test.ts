import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { galleryHtml } from "../src/gallery/server";
import type { GalleryArtifact } from "../src/gallery/types";

async function clientBundle() {
  const build = await Bun.build({
    entrypoints: [
      new URL("../src/gallery/client.tsx", import.meta.url).pathname,
    ],
    target: "browser",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return build.outputs[0]!.text();
}

test("rejected upgrades retain the empty view and copy feedback without reloading on every retry", async () => {
  const js = await clientBundle();
  let galleryRequests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/gallery.js")
        return new Response(js, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/api/session") return Response.json({});
      if (path === "/api/gallery/subscribe")
        return new Response("WebSocket required", { status: 426 });
      if (path === "/api/gallery") {
        galleryRequests++;
        return Response.json({
          workspace: "default",
          artifacts: [],
          capabilities: { links: true, subscriptions: true },
        });
      }
      return new Response(galleryHtml(), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await page.clock.install();
    await page.goto(server.url.href);
    const onboarding = page.locator(".agent-onboarding");
    await onboarding.waitFor();
    await page
      .getByRole("button", { name: "Copy MCP URL", exact: true })
      .click();
    await page.getByText("MCP URL copied", { exact: true }).waitFor();
    const before = await page
      .getByPlaceholder("Search", { exact: true })
      .boundingBox();
    await onboarding.evaluate((node) => {
      node.setAttribute("data-retained", "true");
    });
    await page.clock.runFor(10_000);
    await page
      .getByText("Reconnecting to live updates…", { exact: true })
      .waitFor();
    expect(galleryRequests).toBe(1);
    expect(await onboarding.getAttribute("data-retained")).toBe("true");
    expect(
      await page.getByText("MCP URL copied", { exact: true }).isVisible(),
    ).toBe(true);
    expect(
      await page.getByPlaceholder("Search", { exact: true }).boundingBox(),
    ).toEqual(before);
    const polled = page.waitForResponse((response) =>
      response.url().includes("/api/gallery?"),
    );
    await page.clock.runFor(30_000);
    await polled;
    expect(galleryRequests).toBe(2);
    expect(await onboarding.getAttribute("data-retained")).toBe("true");
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);

test("hosted HTTP live updates retain onboarding during refresh and reconcile after reconnect", async () => {
  const js = await clientBundle();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const artifacts: GalleryArtifact[] = [];
  const encoder = new TextEncoder();
  let galleryGate: Promise<void> | undefined;
  let reachedGallery: (() => void) | undefined;
  let failedConnect = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/gallery.js")
        return new Response(js, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/api/session") return Response.json({});
      if (path === "/api/gallery/events") {
        if (!failedConnect) {
          failedConnect = true;
          return new Response("Restarting", { status: 503 });
        }
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(output) {
              controller = output;
              streams.add(output);
              output.enqueue(encoder.encode("retry: 100\ndata: ready\n\n"));
            },
            cancel() {
              streams.delete(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path === "/api/gallery") {
        reachedGallery?.();
        await galleryGate;
        return Response.json({
          workspace: "default",
          artifacts,
          capabilities: {
            links: true,
            subscriptions: true,
            subscriptionTransport: "events",
          },
        });
      }
      if (path === "/gallery/preview") return new Response("Preview");
      return new Response(galleryHtml(), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const connected = page.waitForResponse(
      (response) =>
        response.url().includes("/api/gallery/events") &&
        response.status() === 200,
    );
    await page.goto(server.url.href);
    await connected;
    const onboarding = page.locator(".agent-onboarding");
    await onboarding.waitFor();
    await onboarding.evaluate((node) =>
      node.setAttribute("data-retained", "true"),
    );
    let releaseGallery: () => void;
    galleryGate = new Promise((resolve) => {
      releaseGallery = resolve;
    });
    const refreshed = new Promise<void>((resolve) => {
      reachedGallery = resolve;
    });
    for (const stream of streams)
      stream.enqueue(encoder.encode("data: changed\n\n"));
    await refreshed;
    expect(await onboarding.getAttribute("data-retained")).toBe("true");
    expect(
      await page.getByText("Loading your library…", { exact: true }).count(),
    ).toBe(0);
    galleryGate = undefined;
    reachedGallery = undefined;
    releaseGallery!();
    artifacts.push({
      key: "missed",
      name: "missed",
      workspace: "default",
      working: true,
      versions: [],
      draftRevision: "one",
    });
    for (const stream of streams) stream.close();
    streams.clear();
    await page.getByTitle("default/missed", { exact: true }).waitFor();
    await page
      .frameLocator('iframe[title="Preview of missed"]')
      .getByText("Preview", { exact: true })
      .waitFor();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);
