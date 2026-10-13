# Deployment plugins

Deployment administrators can make shared UI packages and authenticated server
functions available to every artifact, for example a company component library
or an internal directory lookup. This requires changing and rebuilding the
Artifacts deployment.

If you only need a package in one app or script, use [project dependencies](scripts.md#third-party-dependencies)
instead. This guide covers installing shared plugins and calling their functions.

## Configure a deployment

Install dependencies with Bun and add `artifacts.plugins.ts` at the repository root. `ARTIFACTS_PLUGINS_CONFIG` can select another config file, relative to the repository root. Build both the compiler Worker and app Worker with the same configuration, then deploy them normally. The local CLI compiler reads the same generated browser registry.

```ts
import { definePlugins } from "@sidequery/artifacts/plugins";

export default definePlugins([
  {
    name: "@company/ui",
    description: "Company components and API client",
    browser: "@company/artifact-ui",
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

A browser entry can be an installed package or a source path relative to the config. Declarations are collected at build time; use `types` for an explicit declaration entry when needed. Only configured public package names are available to artifact imports. Add separate entries for public submodules under distinct names. Browser entries must bundle into one browser-compatible JavaScript module. React and the Artifacts SDK share the host runtime. Browser bundles and their declarations must contain only public code; they are delivered to viewers.

## Call a function

An installed browser library can wrap the bridge with its own typed API:

```ts
import { pluginCall } from "sidequery/artifacts";

type DirectoryRecord = { id: string; name: string };
export function lookupRecord(id: string, signal?: AbortSignal) {
  return pluginCall<DirectoryRecord>("company-directory", "lookup", { id }, { signal });
}
```

Artifact source can import that wrapper or call `pluginCall` directly. `plugins_list` exposes installed names, descriptions, JSON schemas and read-only hints through MCP; `plugin_guide` explains the bridge. `artifact_plugin_call` uses `{ plugin, operation, input }` and returns `{ result }` in structured content. The generic return type is the library author's contract; optional `outputSchema` validates results on the server.

## Authentication and behavior

Every call requires an authenticated deployment user. Handlers receive `{ user: { subject, authority }, secrets, signal }`. Omitting `authorize` allows any authenticated deployment user; an optional `authorize(user)` can restrict the whole operation, and the handler must enforce any input-dependent or record-level access. Workspace, library, artifact and version selectors do not change the caller's authority.

Hosted gallery previews, authenticated private standalone artifacts and hosted MCP Apps use the bridge. Public standalone artifacts cannot call functions, even if the browser has a signed-in session. Local compilation supports the built browser libraries; a view without an authenticated hosted bridge rejects function calls. Artifact backends and scripts do not receive the bridge.

Inputs and outputs are JSON, limited to 256 KiB. Inputs are validated against `inputSchema`; `outputSchema` is optional. Calls time out after 30 seconds, and handlers receive an abort signal. Cancellation stops waiting in the browser; it does not roll back server work. Handlers should respect the signal and provide their own idempotency where needed. Server exceptions return generic errors without provider details or secrets.

Server-side plugin functions follow deployment upgrades. Browser libraries and the Artifacts SDK are included in the compiled revision saved on a successful edit; reopening that revision reuses its bundle across restarts and upgrades. A subsequent edit or explicit compilation of the working artifact uses the current build configuration. Keep server APIs compatible with saved browser bundles. This foundation does not manage provider OAuth, install packages at runtime, add artifact permission manifests or implement routing.

## Publish a plugin without rebuilding

A plugin that only provides server functions can also be published into a running
deployment. A published plugin needs no rebuild or redeploy of Artifacts: replacing its
file replaces the plugin. Add an R2 binding named `PLUGINS` to the deployment's
Wrangler configuration:

```json
"r2_buckets": [
  { "binding": "FILES", "bucket_name": "canvas-files" },
  { "binding": "PLUGINS", "bucket_name": "artifacts-plugins" }
]
```

Write the plugin as one module whose default export is `definePlugin(...)`. It takes
the same fields as an entry in `artifacts.plugins.ts`, except `browser` and `types`:

```ts
import { definePlugin } from "@sidequery/artifacts/plugins";

export default definePlugin({
  name: "warehouse",
  description: "Read-only warehouse queries",
  secrets: ["PLUGIN_WAREHOUSE_TOKEN"],
  operations: {
    query: {
      description: "Run a read-only SQL query",
      readOnly: true,
      inputSchema: { type: "object", properties: { sql: { type: "string", minLength: 1 } }, required: ["sql"], additionalProperties: false },
      async handler(input: { sql: string }, { secrets, signal }) {
        // Call the warehouse with secrets.PLUGIN_WAREHOUSE_TOKEN.
      },
    },
  },
});
```

Bundle it from a checkout of this repository, then upload the result to
`plugins/<name>.json` in that bucket:

```sh
bun run scripts/bundle-plugin.ts warehouse.plugin.ts --out warehouse.json
# celld: writes the fleet bucket directly; no node needs to be running.
celld r2 put artifacts-plugins plugins/warehouse.json --path warehouse.json --content-type application/json --bucket s3://<fleet-bucket>
# Cloudflare
bun x wrangler r2 object put artifacts-plugins/plugins/warehouse.json --file warehouse.json --remote
```

The bundle is one file: the handlers, their dependencies, and the input/output
validators. It is reproducible: the same plugin source and Artifacts checkout produce
the same bytes on any machine, so a deployment repository can commit the bundle and
check it against its source in CI. The plugin may live in another repository; its
`@sidequery/artifacts/plugins` import resolves to the checkout used for bundling. Each node uses a new or replaced file within about five seconds. Delete
the object to remove the plugin.

A published plugin works like a build-time plugin. It appears in `plugins_list` and
is called with `artifact_plugin_call` or `pluginCall`. It has the same schemas,
`authorize`, 30 second limit, 256 KiB limit and generic errors. It differs in these
ways:

- **Isolation.** It runs in its own isolate. Its environment contains only the secrets
  it declares, read from deployment variables with the same names. Other variables,
  bindings and storage are unavailable to it.
- **Secrets.** It can declare only variables named `PLUGIN_*`. Write access to the
  bucket therefore never exposes the deployment's own credentials. Adding a secret
  still means changing the deployment's variables.
- **Server only.** Browser libraries still require a deployment build. Artifacts call
  published plugins with `pluginCall` directly.
- **Names.** A build-time plugin with the same name takes precedence.

Anyone who can write `plugins/` in that bucket can run code with the `PLUGIN_*` secrets
it declares. Give that write access only to your release pipeline.

## Complete example

The [runner-status example](../examples/runner-status/README.md) adapts an existing GitHub Actions microapp into a private routed artifact and a read-only MCP operation. It includes a shared hosted collector, explicit caller authorization, persisted snapshots, setup instructions and credential-free tests.
