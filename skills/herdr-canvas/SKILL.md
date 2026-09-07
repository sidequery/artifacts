---
name: herdr-canvas
description: Create and edit Sidequery canvases or hosted HTTP scripts, choose root URL slugs, and use storage, secrets and bundled third-party dependencies through MCP; optional local CLI and Herdr integration.
---

# Sidequery Canvas

Use this skill when the user would benefit from a standalone visual artifact
beside the agent: metrics, tables, reviews, charts, or a small interactive
tool, or asks for a hosted script, HTTP endpoint, API, HTML handler, webhook, or direct artifact URL.

## Runtime and artifact choice

Keep canvases for React UIs; create standalone scripts for arbitrary Workers-compatible HTTP handlers. Both can have a user/AI-chosen root URL at `/<slug>`, with no type prefix or namespace. Discover the available MCP tools first: hosted HTTP MCP exposes `script_*` and `artifact_link`; local Bun stdio and filesystem commands remain canvas-only.

Read `canvas_guide` before writing a canvas and `script_guide` before writing a script. These tools provide the current runtime contract without needing a repository checkout. For hosted scripts, URLs, access, persistence, diagnostics and third-party dependencies, read [docs/scripts.md](../../docs/scripts.md). For dependencies specifically, follow its **Third-party dependencies** recipe: install pinned Workers-compatible packages locally, typecheck original source, prebundle into one module, and send the generated contents to `script_write`. The hosted compiler does not install packages. Keep original source and lockfiles for subsequent edits.

## Hosted scripts and URLs

Use `script_write({name,slug,contents,access})` with a standard default-exported Workers handler. `env.secrets` contains explicitly configured per-script values, `env.sql` provides persistent SQLite, and outbound `fetch` is available. The MCP guide has the complete supported shape and limits.

Use `script_read` and `script_edit` for source changes; check `applied`, `ok` and diagnostics. Invalid drafts retain the working endpoint and chosen slug. Use `script_secrets` rather than embedding credentials, `script_history`/`script_version` for source history, and `script_restore` when restoration is requested.

Use `artifact_link` for either artifact kind, or `slug` on creation. Private is the default; use public only when external access is intended. Return the exact URL supplied by the tool. Explicit `script_run` and visiting a script URL execute user code; reading, listing and editing do not invoke its handler. Validate intended requests and inspect response status/body and `script_logs` before claiming it works.

## Local canvas location

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

## Canvas browser file rules

- Default-export a React component.
- Import from `sidequery/canvas`; `herdr/canvas` and `cursor/canvas` remain compatibility aliases. Read `canvas_guide` for SDK and host contracts.
- No relative imports, npm packages, Node builtins, `fetch()`, or `require()`.
- Embed data inline or use `canvasFetch` when a hosted native server is available.
- Never render empty placeholder sections.

```tsx
import { H1, Stack, Stat, Table, Text } from "sidequery/canvas";

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

`canvas_open` defaults to the inline MCP App viewer. Hosted `/<slug>` links open a standalone interactive canvas with its backend; return the tool-provided URL when a link is requested.

For explicit Herdr pane opening, use `canvas_open({name,target:"herdr"})` on a supported local server or the CLI `canvas open <name>`. This requires Herdr and Terminal Browser; the pane owns its loopback server and browser lifecycle. Verify the pane opened before reporting success. Ordinary canvas creation and hosted URLs do not require Herdr.

## Canvas history

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
