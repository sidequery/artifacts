# Artifacts MCP plugin

Artifacts includes a portable [Agent Plugins 1.0.0](https://agent-plugins.org/) package in `plugins/artifacts`. The root `plugin.json` identifies the package, `mcp.json` configures the connection, and `skills/author` and `skills/setup` provide scoped agent instructions. Skills are discovered by directory convention. OpenAI onboarding is isolated under `extensions.com.openai.onboardingSkill`; other clients may ignore it.

## Configure a package

Generate a new package for a local artifact source directory:

```sh
artifacts plugin --out ./artifacts-plugin --dir /absolute/path/to/project/artifacts
```

Or connect it to the MCP endpoint of your own existing deployment:

```sh
artifacts plugin --out ./artifacts-plugin --url "$ARTIFACTS_MCP_URL"
```

Set `ARTIFACTS_MCP_URL` to the actual endpoint provided by your deployment operator. The command does not deploy a service, invent an endpoint, or establish authentication. Remote URLs require HTTPS; an explicit loopback HTTP URL is accepted for local development. URL credentials, query parameters, and fragments are rejected. Authenticate through the host's connection flow rather than adding credentials to the generated files. See [authentication](authentication.md) for deployment access boundaries.

The destination must not exist and its parent directory must exist. Existing output is never overwritten. Choose a fresh directory for a changed configuration. `--url` and `--dir` are mutually exclusive. Without either, the generator captures the CLI's current default artifact directory into the generated stdio arguments. `--dir` names the source directory itself, not its parent project. The generator does not create or modify that workspace.

The repository template uses `bunx --bun @sidequery/artifacts@0.1.0 mcp`. It requires Bun in the host's executable search path and access to that package version. Its unconfigured directory follows the CLI's environment/workspace defaults. Prefer a generated package with an explicit directory when a host's launch directory is unclear. Local stdio stores source files and history locally; it is separate from hosted libraries and does not execute hosted backends. See [local workspace](local-workspace.md) and [app backends](app-backends.md).

Install the resulting directory through a client that supports portable Agent Plugins. Installation and distribution are client-specific; this package is not a marketplace registration. The portable schema uses `type: "streamable-http"` for remote transport. Registered OpenAI app `.app.json` server mappings are a different configuration surface and are not combined with `mcp.json`.

## Host surfaces

The server builds on MCP Apps and advertises optional OpenAI extensions. Actual availability depends on client support, advertised capabilities, deployment permissions, and authentication. Text-only clients retain ordinary tool results and diagnostics.

| Surface | Purpose and boundary |
| --- | --- |
| Global sidebar | Open the shared Artifacts gallery: folders, search, artifacts and scripts, Preview/Source, saved revisions, Share and Remix. Worker apps open the existing product. The catalog remains permission-filtered. |
| Conversation view | Restore the explicit attached selection or choose an artifact from the library. Browsing does not attach context automatically. There is no stored host conversation identifier or separate conversation membership list. |
| Plugin settings | Native connection settings report the actual workspace and provide an authorized connection check. Endpoint configuration stays with the host; no fake editable preference is stored. |
| Mentions | Search accessible artifacts and scripts with workspace/kind identity; references resolve complete source projects. Mention results do not grant access. |
| Deep links | Open `/artifact?workspace=WORKSPACE&name=NAME` or `/artifact?workspace=WORKSPACE&version_id=ID`, with optional `route` for internal navigation. Encode query values. Server authorization still applies; a link never bypasses owner/team checks. |
| Model context | Publish selected artifact/revision, route, and filter context without automatically sending a prompt. Prompt actions are deliberate user actions. |
| File editor | Open the owned `.artifact.tsx` format through opaque host resources. Writing requires writable capability and an ETag; conflicts require rereading before retrying. |
| Display and theme | Use the host's supported display modes, theme, styles, locale, and timezone; hide unavailable controls and tolerate rejected requests. |
| Onboarding | Verify the configured connection without creating examples, then open the existing library or begin the user's own artifact request. |

Tool visibility distinguishes model calls from app calls; it does not replace server authorization. Host context and file resource identifiers are untrusted input. UI selection, attachments, and cached state cannot expand library, owner, or team access.

## Authoring and verification

The author skill reads `artifact_guide`, guards source edits using `source_hash`/`expected_hash`, suppresses intermediate previews with `preview: false` when supported, and deliberately calls `artifact_open` when the result is ready. Validation diagnostics may accompany an applied edit; they are not a rollback guarantee. Compatible preview refreshes should preserve view state.

Setup verifies connection using tool discovery, `artifact_guide`, and `artifact_list`. It does not create example artifacts or alter the user's library. Host file editing requires its own advertised resource and write capabilities; it is separate from hosted artifact file storage described in [files](files.md).

Hosted project edits use complete snapshots, revision tokens and the existing service authorization. Stale saves preserve the draft for comparison/reload. Legacy local filesystem connections show source read-only; host-managed file editing remains a separate ETag-protected surface. Authored previews run in isolated, sandboxed inline frames so their CSS and React root cannot replace the gallery.

The embedded gallery uses the host's theme variables and transparent outer chrome, a collapsible library, and one toolbar for the selected artifact. Revision selection stays visible; the actions menu contains conversation context, refresh, sharing, remix, and browser destinations. Previews own their spacing. Moving focus between the preview and gallery does not reload the artifact.

Native rich forms require a transport change: the hosted MCP endpoint uses stateless JSON replies, and local stdio has no server-request response router. Neither currently retains the callback correlation needed for OpenAI elicitation. Remix therefore uses the real product form. Migration to bidirectional elicitation or MRTR is not claimed by this package.

The portable manifest and connection shapes follow the [plugin schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json). Optional host integration follows the [OpenAI MCP Extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md); the installed SDK and capability negotiation determine the implemented contract.
