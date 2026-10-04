import { constants } from "node:fs";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { artifactsDirFrom } from "./artifactFile";
import { PLUGIN_ROOT } from "./paths";

const TEMPLATE_FILES = ["plugin.json", "mcp.json", "skills/author/SKILL.md", "skills/setup/SKILL.md"] as const;

function endpointUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP URL must use HTTPS, except explicit loopback HTTP development endpoints");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL must not contain credentials, query parameters, or a fragment");
  }
  return url.href;
}

/** Materialize a plugin in a new directory whose parent already exists. */
export async function writePluginPackage(options: {
  directory: string;
  url?: string;
  /** Artifact source directory, equivalent to `artifacts mcp --dir`. */
  workspace?: string;
}): Promise<{ directory: string }> {
  if (!options.directory.trim()) throw new Error("Plugin output directory must not be empty");
  if (options.url !== undefined && options.workspace !== undefined) {
    throw new Error("Choose a remote MCP URL or a local workspace, not both");
  }
  if (options.workspace !== undefined && !options.workspace.trim()) throw new Error("Workspace must not be empty");
  const url = options.url === undefined ? undefined : endpointUrl(options.url);
  const directory = resolve(options.directory);
  const templateRoot = join(PLUGIN_ROOT, "plugins/artifacts");
  // Reject symlinks in directory components as well as the individual files.
  for (const path of ["plugins", "plugins/artifacts", "plugins/artifacts/skills", "plugins/artifacts/skills/author", "plugins/artifacts/skills/setup"]) {
    if (!(await lstat(join(PLUGIN_ROOT, path))).isDirectory()) {
      throw new Error(`Plugin template is not a regular directory: ${path}`);
    }
  }
  // Fixed paths and O_NOFOLLOW avoid copying arbitrary files or template symlinks.
  const files = await Promise.all(TEMPLATE_FILES.map(async path => {
    const handle = await open(join(templateRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Plugin template is not a regular file: ${path}`);
      return { path, contents: await handle.readFile("utf8") };
    } finally {
      await handle.close();
    }
  }));
  const config = JSON.parse(files.find(file => file.path === "mcp.json")!.contents);
  if (url) {
    config.mcpServers.artifacts = { type: "streamable-http", url };
  } else {
    config.mcpServers.artifacts.args.push("--dir", resolve(options.workspace ?? artifactsDirFrom(process.cwd())));
  }
  files.find(file => file.path === "mcp.json")!.contents = JSON.stringify(config, null, 2) + "\n";

  // A non-recursive mkdir is the exclusive claim. Never clean an existing destination.
  await mkdir(directory);
  try {
    for (const file of files) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, { flag: "wx" });
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory };
}
