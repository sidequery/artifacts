import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GalleryWorkspace, mergeGalleryItems, readWorkspaceCatalog, resolveWorkspaceVersion, selectedGalleryArtifact, workspaceSourceUrl } from "./workspace";
import { GalleryToolError, GalleryTransportProvider, useGalleryTransport, type GalleryTransport } from "./transport";
import type { GalleryArtifact, GalleryData } from "./types";

const older = { id: "old-version", revision: 1, createdAt: "2026-10-01T00:00:00Z", reason: "save", serveCount: 1 };
const latest = { ...older, id: "latest-version", revision: 2 };
const artifact: GalleryArtifact = { key: "alpha:chart", name: "chart", workspace: "alpha", working: true, versions: [latest] };
const script: GalleryArtifact = { ...artifact, key: "alpha:script:chart", kind: "script" };
const gallery: GalleryData = { workspace: "alpha", artifacts: [artifact, script], capabilities: { scripts: true, editing: true, nativeApps: true } };
const transport: GalleryTransport = {
  async tool() { return {}; },
  async loadSource() { return { source: "export default () => null", project: { files: {}, dependencies: {} }, revision_token: "revision" }; },
};

test("catalog pagination merges history without losing working source or content kind", () => {
  const merged = mergeGalleryItems([artifact, script], [{ ...artifact, working: false, versions: [older, latest] }]);
  expect(merged).toHaveLength(2);
  expect(merged.find(item => item.key === artifact.key)).toMatchObject({ working: true, versions: [latest, older] });
  expect(merged.find(item => item.kind === "script")).toEqual(script);
});

test("selection disambiguates same names across kinds and workspaces", () => {
  const other = { ...artifact, key: "beta:chart", workspace: "beta" };
  expect(selectedGalleryArtifact([artifact, script, other], { name: "chart", workspace: "alpha", kind: "script" })).toBe(script);
  expect(selectedGalleryArtifact([artifact, other], { name: "chart", workspace: "beta" })).toBe(other);
  expect(selectedGalleryArtifact([artifact], { version_id: "missing" })).toBeUndefined();
});

test("deep-link lookup finds an authorized revision beyond the first catalog page", async () => {
  const calls: number[] = [];
  const full = await readWorkspaceCatalog(async (_query, offset) => {
    calls.push(offset);
    return offset === 0 ? { ...gallery, artifacts: [], nextOffset: 100 }
      : { ...gallery, artifacts: [{ ...artifact, versions: [older] }], nextOffset: null };
  }, "");
  expect(calls).toEqual([0, 100]);
  expect(selectedGalleryArtifact(full!.artifacts, { workspace: "alpha", version_id: older.id })?.name).toBe("chart");
  expect(selectedGalleryArtifact(full!.artifacts, { version_id: "inaccessible" })).toBeUndefined();
});

test("obsolete selection lookup stops before requesting more catalog pages", async () => {
  let active = true;
  const calls: number[] = [];
  const result = await readWorkspaceCatalog(async (_query, offset) => {
    calls.push(offset); active = false;
    return { ...gallery, nextOffset: 100 };
  }, "", () => active);
  expect(result).toBeUndefined();
  expect(calls).toEqual([0]);
});

test("unresolved conversation deep link starts with loading, never another catalog item", () => {
  const markup = renderToStaticMarkup(<GalleryWorkspace initial={gallery} view="working" transport={transport}
    selection={{ workspace: "alpha", version_id: older.id }}
    search={async () => gallery} renderPreview={async () => () => {}} attach={async () => {}} />);
  expect(markup).toContain("Opening selected artifact…");
  expect(markup).not.toContain('aria-label="Revision of chart"');
});

test("refresh retains an explicitly pinned version even if a catalog page omits it", () => {
  expect(resolveWorkspaceVersion(artifact, older.id)).toBe(older.id);
  expect(resolveWorkspaceVersion(artifact, "working")).toBe("working");
  expect(resolveWorkspaceVersion(artifact, null)).toBe("working");
  expect(resolveWorkspaceVersion({ ...artifact, working: false, versions: [older, latest] }, null)).toBe(latest.id);
});

test("source requests preserve exact workspace, kind, and current versus pinned identity", () => {
  expect(workspaceSourceUrl(script, "working")).toBe("/api/source?workspace=alpha&name=chart&kind=script");
  expect(workspaceSourceUrl(artifact, older.id)).toBe("/api/source?workspace=alpha&version_id=old-version");
});

test("thread entry does not select a global catalog item without an explicit selection", () => {
  const markup = renderToStaticMarkup(<GalleryWorkspace initial={gallery} view="working" transport={transport}
    search={async () => gallery} renderPreview={async () => () => {}} attach={async () => {}} openProduct={async () => {}} />);
  expect(markup).toContain("Choose an artifact for this conversation");
  expect(markup).toContain("Worker apps");
  expect(markup).not.toContain('aria-label="Revision of chart"');
});

test("transport provider uses supplied source and tool operations without changing conflict data", async () => {
  const conflict = new GalleryToolError("Project changed", 409, { applied: false, revision_token: "newer" });
  const provided = { ...transport, async tool() { throw conflict; } };
  let selected: GalleryTransport | undefined;
  function Consumer() { selected = useGalleryTransport(); return null; }
  renderToStaticMarkup(<GalleryTransportProvider transport={provided}><Consumer /></GalleryTransportProvider>);
  expect(selected).toBe(provided);
  try { await selected!.tool("alpha", "artifact_write", {}); throw new Error("Expected conflict"); }
  catch (error) { expect(error).toBe(conflict); expect((error as GalleryToolError).result?.revision_token).toBe("newer"); }
});
