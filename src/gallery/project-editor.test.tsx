import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { editableProject, ProjectEditor } from "./project-editor";

const project = { files: { "lib/helper.ts": "export const value = 1;" }, dependencies: { "lodash-es": "4.17.21" } };
const entries = [{ id: "client", label: "Artifact source", source: "client" }, { id: "server", label: "Server source", source: "server" }];
const props = { entries, project, onProjectChange: () => {}, onEntryChange: () => {}, onValidityChange: () => {} };

test("authoring snapshot retains every helper and dependency without uploading vendor lock files", () => {
  const snapshot = { ...project, lock: { "node_modules/lodash-es/index.js": "vendor source" } };
  expect(editableProject(snapshot)).toEqual(project);
  expect(editableProject(snapshot)).not.toHaveProperty("lock");
  expect(() => editableProject(undefined)).toThrow("missing the project snapshot");
  expect(() => editableProject({ files: {} })).toThrow("Invalid project dependencies");
  expect(() => editableProject({ files: { "lib/helper.ts": null }, dependencies: {} })).toThrow("Invalid project files");
});

test("project source picker exposes both artifact entrypoints and stored helpers", () => {
  const markup = renderToStaticMarkup(<ProjectEditor {...props} />);
  expect(markup).toContain('value="client"');
  expect(markup).toContain('value="server"');
  expect(markup).toContain('value="file:lib/helper.ts"');
  expect(markup).toContain("Add file");
  expect(markup).toContain("4.17.21");
});

test("historical project snapshots expose readable sources and dependencies without authoring controls", () => {
  const markup = renderToStaticMarkup(<ProjectEditor {...props} readOnly />);
  expect(markup).toContain('value="file:lib/helper.ts"');
  expect(markup).not.toContain("Add file");
  expect(markup).not.toContain("New helper file");
  expect(markup.match(/readOnly=""/g)).toHaveLength(2);
  expect(markup).not.toContain('select aria-label="Project file" disabled');
});
