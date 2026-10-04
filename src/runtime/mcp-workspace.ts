import type { App } from "@modelcontextprotocol/ext-apps";
import type { ArtifactWorkspacePayload } from "../mcp/workspace-contract";
import type { ArtifactAppPayload } from "../mcp/app-contract";

export type ArtifactSelection = { name?: string; workspace?: string; version_id?: string; route?: string };

/** Deep links contain authenticated selectors, never file-transfer credentials. */
export function parseArtifactDeepLink(value: string): ArtifactSelection | null {
  let url: URL;
  try { url = new URL(value, "https://artifacts.invalid"); } catch { return null; }
  if (url.origin !== "https://artifacts.invalid" || url.pathname !== "/artifact") return null;
  const name = url.searchParams.get("name") ?? undefined;
  const version_id = url.searchParams.get("version_id") ?? undefined;
  const workspace = url.searchParams.get("workspace") ?? undefined;
  const route = url.searchParams.get("route") ?? "/";
  if ((!name && !version_id) || !route.startsWith("/") || route.startsWith("//")) return null;
  return { name: version_id ? undefined : name, workspace, version_id, route };
}

export async function fetchArtifactPreview(app: App, selection: ArtifactSelection): Promise<ArtifactAppPayload> {
  const { route, ...args } = selection;
  const result = await app.callServerTool({ name: "artifacts_preview", arguments: args });
  if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Unable to open artifact");
  const artifact = result._meta?.artifact as ArtifactAppPayload | undefined;
  if (!artifact?.js) throw new Error("The server returned no artifact preview");
  return artifact;
}

export function mountWorkspace(root: HTMLElement, app: App, initial: ArtifactWorkspacePayload, open: (selection: ArtifactSelection) => Promise<void>) {
  let disposed = false;
  let generation = 0;
  let query = "";
  const section = document.createElement("section");
  const title = document.createElement("h1");
  title.textContent = initial.view === "library" ? "Artifacts" : "Working artifacts";
  const label = document.createElement("label");
  label.textContent = "Search artifacts ";
  const input = document.createElement("input");
  input.type = "search";
  input.maxLength = 200;
  const form = document.createElement("form");
  const search = document.createElement("button");
  search.textContent = "Search";
  search.type = "button";
  label.append(input);
  form.append(label, search);
  const list = document.createElement("ul");
  const notice = document.createElement("p");
  notice.setAttribute("role", "status");
  const more = document.createElement("button");
  more.textContent = "Load more";
  let nextOffset = initial.nextOffset;
  section.append(title, form, list, notice, more);
  root.append(section);
  function render(payload: ArtifactWorkspacePayload, append: boolean) {
    if (!append) list.replaceChildren();
    for (const item of payload.items) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = `Open ${item.name}`;
      const versions = document.createElement("select");
      versions.setAttribute("aria-label", `Revision of ${item.name}`);
      if (item.working) versions.add(new Option("Working source", ""));
      for (const version of item.versions) versions.add(new Option(`Revision ${version.revision}`, version.id));
      button.addEventListener("click", () => {
        const version_id = versions.value || undefined;
        void open({ workspace: item.workspace, name: version_id ? undefined : item.name, version_id }).catch(error => { notice.textContent = String(error); });
      });
      row.append(button, versions);
      list.append(row);
    }
    nextOffset = payload.nextOffset;
    more.hidden = nextOffset === null;
    notice.textContent = list.children.length ? "" : "No artifacts found.";
  }
  async function load(append: boolean) {
    const current = ++generation;
    search.disabled = more.disabled = true;
    try {
      const result = await app.callServerTool({ name: "artifacts_search", arguments: { query, view: initial.view, offset: append ? nextOffset : 0 } });
      if (disposed || current !== generation) return;
      if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Search failed");
      const payload = result._meta?.workspace as ArtifactWorkspacePayload | undefined;
      if (!payload) throw new Error("Workspace response was missing");
      render(payload, append);
    } catch (error) { if (!disposed && current === generation) notice.textContent = String(error); }
    finally { if (!disposed && current === generation) search.disabled = more.disabled = false; }
  }
  const searchNow = () => { query = input.value; void load(false); };
  search.addEventListener("click", searchNow);
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchNow(); } });
  form.addEventListener("submit", event => { event.preventDefault(); });
  more.addEventListener("click", () => { void load(true); });
  render(initial, false);
  return () => { disposed = true; generation++; section.remove(); };
}
