# Scripts and direct canvas links

The hosted gallery supports canvases and standalone scripts. Either can have a chosen root URL such as `/sales-dashboard` or `/stripe-webhook`. Canvas URLs open the interactive canvas and its backend; script URLs invoke the script's HTTP handler. Slugs are unique across the deployment, including across artifact types and libraries. Existing application routes are reserved.

## Gallery

Choose **New script**, enter a name and URL slug, and edit the TypeScript source. Select **Private** or **Public**, then **Save script**. Scripts appear alongside canvases in the library. Selecting a script loads its source without running it.

For either artifact, the **URL /** field and access selector control its direct link. **Save link** updates the settings; **Open** visits the URL and **Copy URL** copies its absolute address. Opening a script URL sends a GET request and runs its handler. Updating the source keeps the chosen URL. Changing the slug changes the URL; old URLs are not aliases.

The script editor's **Save script** validates and saves the working source. A successful update serves immediately, without a separate publishing step. A failed validation keeps the previous working revision and access settings serving. If the first save is invalid, its chosen slug is retained with the draft until a valid correction creates the URL. The **Version** selector lets you read older revisions; **Restore revision** makes the selected revision current. **Download source** downloads the selected source.

Expand **Run** to choose an HTTP method, path, headers as a JSON object, and a text body for methods other than GET and HEAD. **Run script** invokes the current saved script, even when you are browsing a historical revision or have unsaved edits. The response displays its status, headers, and decoded text body. Binary bodies are shown as base64. Returned HTML is displayed as text in the runner.

Expand **Logs** and select **Load logs** to inspect recent execution output. Under **Secrets**, enter a name and value and select **Save secret**; the value field clears after saving. Enter a name and select **Remove secret** to delete it. Stored secret values are never loaded into the editor or source history.

These controls are available in the hosted gallery. The local gallery continues to support existing canvases.

## Script handler

A script implements a standard Workers fetch handler. It can return JSON, HTML, binary data, redirects, or any other HTTP response supported by the runtime. Webhooks are one application of this contract.

```ts
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/health")) {
      return Response.json({ ok: true });
    }
    return new Response("Hello", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<ScriptEnv>;
```

`ScriptEnv` is available during type checking. It contains `secrets: Record<string, string>` and `sql: SqlStorage`. Outbound `fetch` is available. `ctx.waitUntil` can extend background work associated with a request. Scripts can import supported `cloudflare:` and `node:` builtins. Source is currently a single TypeScript module; third-party packages must be bundled into that source beforehand. Code must be compatible with the Workers runtime; this is not a general server process or scheduling system.

Use `env.secrets.NAME` for a configured secret. For example, a handler can verify a provider signature against the original request body. Script HTTP requests preserve their methods, query strings, and body bytes. The gateway strips cookies and Cloudflare Access assertion/service-token headers; private routes also strip the authorization credential used for management authentication.

Each script has its own persistent SQLite storage. The database survives source updates and revision restores:

```ts
export default {
  async fetch(request, env) {
    env.sql.exec("create table if not exists visits (at text not null)");
    env.sql.exec("insert into visits values (?)", new Date().toISOString());
    const row = env.sql.exec<{ count: number }>(
      "select count(*) as count from visits",
    ).one();
    return Response.json(row);
  },
} satisfies ExportedHandler<ScriptEnv>;
```

Do not assume an in-memory global persists between requests or updates. Each execution is limited to 30 seconds of CPU and 50 subrequests, in addition to the Workers runtime limits. Logs retain the latest 100 entries with messages capped at 2 KiB. Secret strings are redacted from captured console output; handlers still control their own response bodies and outbound requests.

## Access

Links default to **Private** and use the artifact's existing library permissions. Management APIs and the gallery remain authenticated. Setting a link to **Public** allows external callers to invoke or view it; a public script can implement its own authentication through request headers or signatures.

If Cloudflare Access protects the deployment's entire hostname, configure an Access bypass for the intended public paths so external callers can reach the Worker. The artifact's access setting does not override an Access policy that blocks the request before it reaches the application.

HTML served at artifact URLs is sandboxed with a response Content Security Policy to isolate it from the management origin. Script responses cannot set cookies through these routes. This allows HTML handlers while keeping the gallery session separate.

## MCP

Agents use `script_write`, `script_read`, `script_edit`, `script_list`, `script_history`, `script_restore`, `script_run`, `script_logs`, and `script_secrets` to manage scripts. `artifact_link` sets the slug and access for either `kind: "canvas"` or `kind: "script"`. Creation and link results include the resulting URL.

`script_run` takes a request object with `path`, `method`, `headers` as an array of `[name, value]` pairs, and an optional base64 `body`. Its structured result contains `response` with `status`, `statusText`, `headers`, and an optional base64 `body`. For example:

```json
{
  "name": "script_run",
  "arguments": {
    "name": "echo",
    "request": {
      "path": "/",
      "method": "POST",
      "headers": [["content-type", "text/plain"]],
      "body": "aGVsbG8="
    }
  }
}
```
