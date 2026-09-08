# Artifact backends and storage

The local HTTP server and hosted Cloudflare deployments can pair a browser
`.artifact.tsx` with an `ArtifactServer` backend. The server is a generated Durable Object class and uses its own
SQLite through `ctx.storage.sql` and key/value storage through `ctx.storage.kv` directly. The browser calls it with
`artifactFetch`, which accepts a path and standard `RequestInit` and returns a
standard `Response`:

```tsx
import { Button, Text, artifactFetch, useState, useEffect } from "sidequery/artifacts";

export default function Counter() {
  const [value, setValue] = useState<number | null>(null);
  async function load(method = "GET") {
    const response = await artifactFetch("/counter", { method });
    if (!response.ok) throw new Error(`Counter failed (${response.status})`);
    setValue((await response.json() as { value: number }).value);
  }
  useEffect(() => { void load(); }, []);
  return <><Text>Count: {value ?? "loading"}</Text><Button onClick={() => { void load("POST"); }}>Increment</Button></>;
}
```

```ts
import { DurableObject } from "cloudflare:workers";

export class ArtifactServer extends DurableObject {
  fetch(request: Request): Response {
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key, value integer not null)");
    this.ctx.storage.sql.exec("insert or ignore into counter values (1, 0)");
    if (request.method === "POST") this.ctx.storage.sql.exec("update counter set value = value + 1 where id = 1");
    const row = this.ctx.storage.sql.exec<{ value: number }>("select value from counter where id = 1").one();
    return Response.json(row);
  }
}
```

The complete checked-in pair is
[`examples/counter.artifact.tsx`](../examples/counter.artifact.tsx) and
[`examples/counter.artifact.server.ts`](../examples/counter.artifact.server.ts).
From a source checkout, seed it into the hosted runtime with
`bun run seed:cloudflare default counter`. For the local HTTP server, use
`ARTIFACTS_MCP_URL=http://127.0.0.1:4786/mcp bun run seed:cloudflare default counter`.
`artifactFetch` carries ordinary HTTP method, headers and body through the Artifact
host; it does not expose an internal endpoint or bearer credential to artifact
code. Use relative paths. Cross-origin and protocol-relative URLs are rejected,
and request and response bodies are limited to 256 KiB.

On these servers, `artifact_write` accepts `server` source alongside `contents`. Omitting
`server` preserves the existing server; passing `null` removes it without
deleting its database. Use `artifact_read` or `artifact_edit` with `part: "server"`
for targeted server changes. Client and server source are versioned and restored
together. The database is live state keyed by library, workspace and artifact name:
editing or restoring source reloads the code while preserving that state, and
opening an archived version does not restore an old database snapshot.

In authenticated hosted deployments, private artifacts receive databases isolated to the verified signed-in user. A
team artifact shares one database with members authorized for that deployment's
team library. Private and team artifacts with the same workspace and name remain
separate. Generated servers receive Durable Object storage; ordinary D1, R2 and
custom Worker bindings are not provided. The workspace Bun CLI, stdio MCP server and
workspace gallery do not execute artifact servers, so `artifactFetch` reports that server
requests are unavailable there.

Hosted artifacts and the managed local celld server also provide **per-artifact
files** through `artifactFiles.upload`, `list`, `read`, `download`, and `delete`.
Files use native R2, remain live across source edits, and need no server code.
Uploads support up to 25 MiB; binary transfers bypass the 256 KiB request bridge.
Public artifact links expose files read-only. See [file storage and deployment](files.md)
and [the file artifact example](../examples/files.artifact.tsx).

Hosted deployments choose `AUTH_MODE=access` for the existing Cloudflare Access
setup or `AUTH_MODE=better-auth` for provider-configurable sign-in. Better Auth
runs inside the Artifacts Worker with a deployment-owned D1 database; it does not
require a central Artifacts authentication service or offer password registration.
Deployers can pass any supported Better Auth social-provider configuration,
configure generic OIDC, or extend the TypeScript provider seam. The gallery and
remote MCP OAuth flow resolve to the same user identity. See
[Cloudflare setup](cloudflare.md) for provider examples, D1 migrations and
admission rules.
