# Herdr terminal panes

To open artifacts beside a terminal agent, install Herdr 0.8.2+ and
[Terminal Browser](https://github.com/zenbu-labs/terminal-browser), then link a
source checkout. Herdr is only needed for terminal panes.

```bash
herdr plugin install zenbu-labs/terminal-browser/herdr-plugin --yes
herdr plugin link /path/to/artifacts
```

Run `bun install --frozen-lockfile` in the checkout before linking it. The plugin
ID and pane entrypoint are `herdr.artifacts` and `artifacts`. Relink an existing
checkout to register the new plugin name.

Use `artifacts open NAME` to open a workspace artifact. From MCP, use
`artifact_open({name: "overview", target: "herdr"})` with the workspace stdio
server. The HTTP server supports inline views, not Herdr pane targets.
