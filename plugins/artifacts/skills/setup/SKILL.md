---
name: setup
description: Verify an Artifacts plugin connection and explain the configured local workspace or user-owned remote deployment without creating sample work.
---

Inspect the packaged `../../mcp.json` relative to this skill directory. Determine whether it launches local stdio or connects to a configured remote endpoint. Use the host's supported plugin installation and authentication flow; do not assume one client's installation UI exists in another.

For local stdio, Bun must be available to the host. An explicit `--dir` names the artifact source directory. Without it, the CLI resolves its configured environment or the launching workspace's `artifacts` directory (with legacy compatibility); the host's launch directory can differ from the user's project. If the target is unclear, establish the intended directory before creating work. The local workspace is separate from a hosted library and does not execute hosted backends.

For remote MCP, use the endpoint of the user's existing Artifacts deployment. Require HTTPS except for an explicitly selected loopback HTTP development server. Never invent a public service URL or embed tokens in a manifest, URL, or skill. Complete authentication through normal host tooling and verify the current owner/team context. If authentication is unavailable, report the exact connection problem; do not hunt for credentials.

Verify by discovering the advertised tools and calling `artifact_guide` and `artifact_list` with their current schemas. Do not write, remix, restore, or create a demonstration artifact as a connection check. If tools are unavailable, inspect the host's connection error and configured transport before changing anything.

Report whether the connection succeeded, which workspace or deployment it uses, and which host surfaces are actually available. MCP Apps, sidebar and conversation views, mentions, deep links, and file editing depend on advertised capabilities and client support. Offer the author skill for the user's next artifact request; setup itself is complete after read-only verification.
