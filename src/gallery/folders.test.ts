import { expect, test } from "bun:test";
import { artifactFolders } from "./folders";
import type { GalleryArtifact } from "./types";
const item = (workspace: string): GalleryArtifact => ({ key: workspace, name: "report", workspace, working: true, versions: [] });

test("folder tree retains nested folders and distinct files with the same name", () => {
  const workspaces = ["Reports/Monthly", "Reports/Weekly", "default"];
  const root = artifactFolders(workspaces.map(item), workspaces);
  expect(root.artifacts.map(item => item.workspace)).toEqual(["default"]);
  const reports = root.folders.get("Reports")!;
  expect([...reports.folders.keys()]).toEqual(["Monthly", "Weekly"]);
  expect(reports.folders.get("Weekly")!.artifacts[0]!.workspace).toBe("Reports/Weekly");
});

test("local folders omit shared machine paths and keep stable nesting when filtered", () => {
  const workspaces = ["/Users/nico/Reports", "/Users/nico/Reports/Monthly"];
  const root = artifactFolders([item(workspaces[1]!)], workspaces);
  expect([...root.folders.keys()]).toEqual(["Reports"]);
  expect(root.folders.get("Reports")!.folders.get("Monthly")!.artifacts).toHaveLength(1);
});
