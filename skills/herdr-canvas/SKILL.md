---
name: herdr-canvas
description: Create, typecheck, and open live React canvases beside a Herdr agent using herdr-canvas and Terminal Browser.
---

# Herdr Canvas

Use this skill when the user would benefit from a standalone visual artifact
beside the agent: metrics, tables, reviews, charts, or a small interactive
tool. Do not dump that output as a markdown table.

## Location

Write exactly one file per canvas:

```text
<workspace>/canvases/<name>.canvas.tsx
```

Use kebab-case names. Do not put canvases in subfolders.

Discover the plugin root if you need the CLI:

```bash
herdr plugin list --plugin herdr.canvas --json
```

Then:

```bash
bun run "<plugin_root>/src/cli.ts" list
bun run "<plugin_root>/src/cli.ts" open <name>
```

Prefer the MCP tools when available; CLI equivalents are available for agents
without MCP. Create with `canvas_write`, then use `canvas_read` line ranges and
`canvas_edit` exact-text replacements for targeted changes instead of resending
the whole file. Pass the read result's `source_hash` as `expected_hash` when editing.
Check returned diagnostics: typecheck errors leave edits applied. For argument
shapes and CLI examples, read the "Targeted reads and edits" section in
[README.md](../../README.md).

## File rules

- Default-export a React component.
- Import **only** from `herdr/canvas` (or the `cursor/canvas` alias).
- No relative imports, npm packages, Node builtins, `fetch()`, or `require()`.
- Embed all data inline.
- Never render empty placeholder sections.

```tsx
import { H1, Stack, Stat, Table, Text } from "herdr/canvas";

export default function BillingReview() {
  return (
    <Stack gap={16}>
      <H1>Billing review</H1>
      <Text>Source: warehouse · last 7 days</Text>
      <Stat value="$12.4k" label="Uninvoiced usage" tone="warning" />
      <Table
        headers={["Customer", "Usage"]}
        rows={[["acme", "$4,200"], ["globex", "$3,100"]]}
      />
    </Stack>
  );
}
```

## Opening

`canvas_open` / `herdr-canvas open` will typecheck, bundle with Bun, and open a
pane owned by `herdr.canvas`. The Canvas pane manages its loopback server and
runs Terminal Browser internally in app mode. Never hand the user a localhost
URL as the Canvas result. Link the canvas source file in your reply only as a
secondary reference after verifying the Canvas pane opened.

Required runtime: `terminal-browser` from `zenbu-labs/terminal-browser`.

## History

When retrieving an earlier artifact, use `canvas_history` (optional `name`) and
`canvas_version` (`version_id`). History includes deleted working files.
`canvas_open` (`version_id`, optional `event_id`, `placement`) opens saved raw
TSX using the installed SDK, with isolated initial UI state. It does not change
the working source. CLI equivalents are `history [NAME]`, `show VERSION_ID`, and
`open --version VERSION_ID [--event EVENT_ID]`. Use `show VERSION_ID --source`
for raw TSX on stdout. `web --port 4784` starts the local searchable gallery;
it stays in the foreground until Ctrl-C and previews have isolated UI state.

Use `canvas_restore` / `restore VERSION_ID` only when restoring the working file
is requested. It archives the current source first, adds a new revision, and
preserves later history and working UI state. Check the returned diagnostics.
Only successfully served source changes are automatically archived; intermediate
unserved edits are not. Replays compile saved source, not an archived bundle.
