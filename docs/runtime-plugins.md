# Deployment plugins

A deployment can install ordinary browser packages and expose authenticated server functions. Canvases import the browser packages and call functions through the existing viewer bridge. Routing is a separate feature.

## Configure a deployment

Install dependencies with Bun and add `canvas.plugins.ts` at the repository root. `CANVAS_PLUGINS_CONFIG` can select another config file, relative to the repository root. Build both the compiler Worker and app Worker with the same configuration, then deploy them normally. The local CLI compiler reads the same generated browser registry.

```ts
import { definePlugins } from "@sidequery/canvas/plugins";

export default definePlugins([
  {
    name: "@company/ui",
    description: "Company components and API client",
    browser: "@company/canvas-ui",
  },
  {
    name: "company-directory",
    description: "Look up directory records",
    secrets: ["DIRECTORY_TOKEN"],
    operations: {
      lookup: {
        description: "Look up a directory record by ID",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
        async handler(input: { id: string }, { user, secrets, signal }) {
          // Enforce record-level access for user.subject + user.authority here.
          const response = await fetch(
            `https://directory.example/records/${encodeURIComponent(input.id)}`,
            { headers: { authorization: `Bearer ${secrets.DIRECTORY_TOKEN}` }, signal },
          );
          if (!response.ok) throw new Error("Directory lookup failed");
          return response.json();
        },
      },
    },
  },
]);
```

Configure secret values as app Worker bindings through the existing deployment tooling. The config lists binding names, never values. Plugins are trusted deployment code; the binding selection is an explicit handler interface, not isolation from other installed server code.

A browser entry can be an installed package or a source path relative to the config. Declarations are collected at build time; use `types` for an explicit declaration entry when needed. Only configured public package names are available to canvas imports. Add separate entries for public submodules under distinct names. Browser entries must bundle into one browser-compatible JavaScript module. React and the Canvas SDK share the host runtime. Browser bundles and their declarations must contain only public code; they are delivered to viewers.

## Call a function

An installed browser library can wrap the bridge with its own typed API:

```ts
import { pluginCall } from "sidequery/canvas";

type DirectoryRecord = { id: string; name: string };
export function lookupRecord(id: string, signal?: AbortSignal) {
  return pluginCall<DirectoryRecord>("company-directory", "lookup", { id }, { signal });
}
```

Canvas source can import that wrapper or call `pluginCall` directly. `plugins_list` exposes installed names, descriptions, JSON schemas and read-only hints through MCP; `plugin_guide` explains the bridge. `canvas_plugin_call` uses `{ plugin, operation, input }` and returns `{ result }` in structured content. The generic return type is the library author's contract; optional `outputSchema` validates results on the server.

## Authentication and behavior

Every call requires an authenticated deployment user. Handlers receive `{ user: { subject, authority }, secrets, signal }`. Omitting `authorize` allows any authenticated deployment user; an optional `authorize(user)` can restrict the whole operation, and the handler must enforce any input-dependent or record-level access. Workspace, library, canvas and version selectors do not change the caller's authority.

Hosted gallery previews, authenticated private standalone canvases and hosted MCP Apps use the bridge. Public standalone canvases cannot call functions, even if the browser has a signed-in session. Local compilation supports the built browser libraries; a view without an authenticated hosted bridge rejects function calls. Canvas backends and scripts do not receive the bridge.

Inputs and outputs are JSON, limited to 256 KiB. Inputs are validated against `inputSchema`; `outputSchema` is optional. Calls time out after 30 seconds, and handlers receive an abort signal. Cancellation stops waiting in the browser; it does not roll back server work. Handlers should respect the signal and provide their own idempotency where needed. Server exceptions return generic errors without provider details or secrets.

Plugins follow normal deployment upgrades. There is no per-canvas plugin version or retained historical runtime: saved canvases use the deployment's current plugin packages. Keep APIs compatible when upgrading. This foundation does not manage provider OAuth, install packages at runtime, add artifact permission manifests or implement routing.

## Complete example

The [runner-status example](../examples/runner-status/README.md) adapts an existing GitHub Actions microapp into a private routed canvas and a read-only MCP operation. It includes a shared hosted collector, explicit caller authorization, persisted snapshots, setup instructions and credential-free tests.
