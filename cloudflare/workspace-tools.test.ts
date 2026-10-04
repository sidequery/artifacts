import { expect, test } from "bun:test";
import { workspaceTool } from "./workspace-tools";
import type { GalleryData } from "../src/gallery/types";

test("mention search reaches matching archived artifacts after empty catalog pages", async () => {
  const offsets: number[] = [];
  const result = await workspaceTool({ workspace: "current", async gallery(all, offset = 0): Promise<GalleryData> {
    expect(all).toBe(true);
    offsets.push(offset);
    if (offset === 0) return { workspace: "current", artifacts: [{ key: "other", workspace: "current", name: "other", working: true, versions: [] }], nextOffset: 100 };
    return { workspace: "current", artifacts: [{ key: "archived", workspace: "research", name: "matching-revenue", working: false, versions: [{ id: "saved-version", revision: 3, createdAt: "2026-10-03T00:00:00Z", reason: "saved", serveCount: 1 }] }], nextOffset: null };
  } }, "artifacts_mentions", { query: "REVENUE" });
  expect(offsets).toEqual([0, 100]);
  const items = result.structuredContent!.items as { uri: string; name: string }[];
  expect(items).toHaveLength(1);
  expect(items[0]?.name).toBe("matching-revenue");
  expect(new URL(items[0]!.uri).searchParams.get("version_id")).toBe("saved-version");
});

test("working and library views preserve scripts and the full authorized gallery fields", async () => {
  const gallery: GalleryData = { workspace: "default", libraryScope: "team", capabilities: { editing: true, scripts: true, links: true }, nextOffset: 100,
    artifacts: [{ key: "script-key", name: "refresh", kind: "script", workspace: "research", working: true, versions: [], slug: "refresh-data", access: "private", live: { id: "revision", revision: 2, revision_token: "token" } }] };
  for (const tool of ["artifacts_library", "artifacts_working", "artifacts_search"]) {
    const result = await workspaceTool({ workspace: "default", productUrl: "https://artifacts.example/", async gallery(all) { expect(all).toBe(true); return gallery; } }, tool, {});
    expect(result._meta).toMatchObject({ workspace: { items: gallery.artifacts, gallery, productUrl: "https://artifacts.example/", nextOffset: 100 } });
  }
  const mentions = await workspaceTool({ workspace: "default", async gallery() { return { ...gallery, nextOffset: null }; } }, "artifacts_mentions", { query: "refresh" });
  const items = mentions.structuredContent!.items as { uri: string; title: string }[];
  expect(new URL(items[0]!.uri).searchParams.get("kind")).toBe("script");
  expect(new URL(items[0]!.uri).searchParams.get("workspace")).toBe("research");
  expect(items[0]!.title).toContain("script");
});
