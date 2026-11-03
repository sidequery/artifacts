---
name: artifacts
description: Create and edit Sidequery artifacts, including hosted HTTP endpoints without a UI, choose root URL slugs, and use storage, secrets and bundled third-party dependencies through MCP; optional local CLI and Herdr integration.
---

# Sidequery Artifacts

Use this skill when the user would benefit from a standalone visual artifact
beside the agent: metrics, tables, reviews, charts, or a small interactive
tool, or asks for a hosted script, HTTP endpoint, API, HTML handler, webhook, or direct artifact URL.

## Runtime and artifact choice

An artifact has a React UI, a server, or both. Use a UI for anything visual; use a server with no UI for an HTTP endpoint, API, HTML handler, webhook, or scheduled job. Any artifact can have a user/AI-chosen root URL at `/<slug>`, with no type prefix or namespace. Hosted HTTP MCP runs servers; local Bun stdio and filesystem commands are UI-only.

Read `artifact_guide` before writing an artifact, with topic `backend` for servers. It provides the current runtime contract without needing a repository checkout. For hosted endpoints, URLs, access, persistence, diagnostics and third-party dependencies, read [docs/scripts.md](../../docs/scripts.md). Pass exact dependency versions in `project.dependencies`; the service resolves and archives them. Keep original source for subsequent edits.

## Hosted endpoints and URLs

Use `artifact_write({name,slug,access,server})` without `contents`, where `server` is a standard default-exported Workers handler typed `ExportedHandler<ServerEnv>`. `env.secrets` contains explicitly configured values, `env.sql` provides persistent SQLite, `env.storage` provides KV and transactions, and outbound `fetch` is available. The URL receives paths relative to the slug. The MCP guide has the complete supported shape and limits.

Use `artifact_read` and `artifact_edit` for source changes; they select the server when there is no UI. Check `applied`, `ok` and diagnostics. Invalid drafts retain the working endpoint and chosen slug. Use `artifact_secrets` rather than embedding credentials, `artifact_history`/`artifact_version` for source history, and `artifact_restore` when restoration is requested.

Use `artifact_link`, or `slug` on creation. Private is the default; use public only when external access is intended. Return the exact URL supplied by the tool. Explicit `artifact_request` and visiting the URL execute user code; reading, listing and editing do not invoke its handler. Validate intended requests and inspect response status/body and `artifact_logs` before claiming it works.

Scripts created with the older `script_*` tools are listed as `legacy_scripts`; the same `artifact_*` tools operate on them by name, and `artifact_remix` copies one into a server-only artifact.

## Local artifact location

Write exactly one file per artifact:

```text
<workspace>/artifacts/<name>.artifact.tsx
```

Use kebab-case names. Do not put artifacts in subfolders.

Discover the plugin root if you need the CLI:

```bash
herdr plugin list --plugin herdr.artifacts --json
```

Then:

```bash
bun run "<plugin_root>/src/cli.ts" list
bun run "<plugin_root>/src/cli.ts" open <name>
```

Prefer the MCP tools when available; CLI equivalents are available for agents
without MCP. Create with `artifact_write`, then use `artifact_read` line ranges and
`artifact_edit` exact-text replacements for targeted changes instead of resending
the whole file. Pass the read result's `source_hash` as `expected_hash` when editing.
Check returned diagnostics: typecheck errors leave edits applied. For argument
shapes and CLI examples, read the "Targeted reads and edits" section in
[README.md](../../README.md).

## Artifact browser file rules

- Default-export a React component.
- Import from `sidequery/artifacts`; `herdr/canvas` and `cursor/canvas` remain compatibility aliases. Read `artifact_guide` for SDK and host contracts.
- No relative imports, npm packages, Node builtins, `fetch()`, or `require()`.
- Embed data inline or use `artifactFetch` when a hosted native server is available.
- Never render empty placeholder sections.

```tsx
import { H1, Stack, Stat, Table, Text } from "sidequery/artifacts";

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

`artifact_open` defaults to the inline MCP App viewer. Hosted `/<slug>` links open a standalone interactive artifact with its backend; return the tool-provided URL when a link is requested.

For explicit Herdr pane opening, use `artifact_open({name,target:"herdr"})` on a supported local server or the CLI `artifacts open <name>`. This requires Herdr and Terminal Browser; the pane owns its loopback server and browser lifecycle. Verify the pane opened before reporting success. Ordinary artifact creation and hosted URLs do not require Herdr.

## Artifact history

When retrieving an earlier artifact, use `artifact_history` (optional `name`) and
`artifact_version` (`version_id`). History includes deleted working files.
`artifact_open` (`version_id`, optional `event_id`, `placement`) opens saved raw
TSX using the installed SDK, with isolated initial UI state. It does not change
the working source. CLI equivalents are `history [NAME]`, `show VERSION_ID`, and
`open --version VERSION_ID [--event EVENT_ID]`. Use `show VERSION_ID --source`
for raw TSX on stdout. `web --port 4784` starts the local searchable gallery;
it stays in the foreground until Ctrl-C and previews have isolated UI state.

Use `artifact_restore` / `restore VERSION_ID` only when restoring the working file
is requested. It archives the current source first, adds a new revision, and
preserves later history and working UI state. Check the returned diagnostics.
Only successfully served source changes are automatically archived; intermediate
unserved edits are not. Replays compile saved source, not an archived bundle.
