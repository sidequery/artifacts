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
