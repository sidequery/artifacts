---
name: author
description: Create or edit React artifacts using the configured Artifacts MCP server; inspect existing artifacts, validate changes, and deliberately open the result.
---

Read `artifact_guide` once in the current conversation before authoring. It owns the SDK exports, allowed imports, runtime restrictions, and validation behavior. Use the connected server's current tool schemas rather than assuming every deployment exposes the same tools.

The server advertises six direct artifact tools plus `artifacts_discover`, `artifacts_query` and `artifacts_execute`. For history, restore, files, scripts, schedules, secrets, plugins or native Workers, search `artifacts_discover` with `query`, then inspect the chosen `operation` for its exact schema and relevant guide. Call it using `{ operation, arguments }` through the recommended dispatcher. Use `include_docs: false` when its guide is already loaded. All supported operations use the same connection; do not switch configuration. Query enforces reads; execution, including authored HTTP GETs and plugin calls, requires execute. Shared dispatch retains validation, authorization and preview results.

For an existing artifact, read the relevant source with `artifact_read` before editing. Pass its `source_hash` as `expected_hash` to `artifact_edit`; on conflict, reread and reconcile the user's changes. Use exact replacements with unique matches. A failed validation may leave source applied: inspect the result and repair diagnostics instead of assuming rollback.

Use `preview: false` for intermediate writes, edits, and restores when supported by the advertised tool schema. After the requested result passes validation, call `artifact_open` deliberately to show it. Preserve compatible view state and internal navigation. Do not send a user prompt merely to publish selection context; sending a prompt requires the user's action or request.

Respect the connected identity, selected owner/library, team permissions, and workspace. A UI attachment, mention, deep link, or hidden tool is not authorization to access another owner's data. Read the current selection before mutation; ask when the intended target is materially ambiguous. Sharing or moving ownership requires the user's instruction. Never put credentials, transfer URLs, or secret values in source or plugin configuration.

For hosted server, database, or file work, check current runtime capabilities and the SDK guide. File-based local stdio workspaces do not execute hosted backends. Do not replace durable storage with UI state. When editing a host file resource, retain its opaque URI, require writable capability, and use the current ETag; reread and reconcile conflicts.

Finish with the artifact opened when the host supports it, validation status, and any concrete remaining limitation. A successful preview request does not prove the user viewed it.
