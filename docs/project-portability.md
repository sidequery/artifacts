# Project archives

Use a project archive to copy an app or script to another Artifacts installation,
or keep a portable copy of its source and dependencies. It is **not a data
backup**: databases, uploaded files, secrets, schedules, and access settings are
not included.

## Export and import in the gallery

Export project downloads the selected saved working copy or historical revision as a version 1 `.artifact-project.json` archive. Unsaved browser changes are excluded. Download entrypoint remains available for a single source file.

An archive includes the artifact client and optional native server, or a script entrypoint, relative helper modules, exact dependency declarations and the complete archived package source/type snapshot. Import preserves these bytes without fetching packages or running installation scripts. Deployment-provided SDK and plugin packages still come from the destination runtime; source must validate there before it can deploy.

Import project requires a fresh name and optionally a fresh URL slug. Hosted imports start private with fresh databases, files, UI state, secrets and schedules. Existing working and historical identities cannot be overwritten. Invalid imports remain saved drafts with diagnostics and have no live URL until corrected. An archive copies no runtime data or access settings. Source code may contain embedded application data, so review it before sharing.

## Archive format and limits

The archive format is `sidequery-artifacts-project`, version `1`, with `kind`, `name`, `source`, `server_source` and `project` (`files`, `dependencies`, `lock`). Unknown fields and versions, unsafe paths, incomplete snapshots and oversized projects are rejected. The compact archive is limited to 10 MiB; entrypoints retain the 256 KiB limit, helpers the 64-file/1 MiB limit, and package snapshots the 4096-file/8 MiB limit.

## MCP

MCP exposes `artifact_export` and `script_export` with exactly one of `name` or `version_id`. `artifact_import` and `script_import` accept `new_name`, `archive` and an optional hosted `slug`. Ordinary writes still treat `project.lock` as read-only; importing a complete archive is the explicit way to supply a saved dependency snapshot. Only import requests may exceed the ordinary 1 MiB management body limit.

## Local files

```sh
artifacts export dashboard --output dashboard.artifact-project.json
artifacts export --version VERSION_ID --output archived.artifact-project.json
artifacts import dashboard-copy --file dashboard.artifact-project.json
artifacts export handler --kind script --output handler.artifact-project.json
artifacts import handler-copy --file handler.artifact-project.json
```

Export refuses to replace an existing output file. Import also accepts `--stdin`. Local MCP and the filesystem gallery support interactive artifact imports/exports. The CLI additionally stores and exports script archives. Filesystem previews do not execute scripts or native servers; their source is preserved for later hosted deployment. Artifact history, remix and restore preserve backend source alongside the client and dependencies.
