# Authentication and access

Artifacts uses your deployment's sign-in system. There is no central Artifacts
account. Signing in to the application is separate from the Cloudflare or object
store credentials used to deploy it.

- [Connect to an existing deployment](#connect-to-an-existing-deployment)
- [Choose an authentication mode](#choose-an-authentication-mode)
- [Set up Better Auth](#set-up-better-auth)
- [Set up Cloudflare Access](#set-up-cloudflare-access)
- [Configure celld](#configure-celld)
- [Understand library and URL permissions](#library-and-url-permissions)
- [Troubleshoot sign-in](#troubleshooting)

## Connect to an existing deployment

**Gallery:** open your deployment's URL, such as `https://artifacts.example.com`,
and sign in with one of its configured providers. The deployment administrator
must admit your account. Choose **My library** or **Team library** in the gallery.

**Coding agent:** add a remote HTTP MCP server using one of these URLs:

```text
https://artifacts.example.com/mcp
https://artifacts.example.com/mcp?library=team&workspace=default
```

The first selects your personal library and the default workspace. The second
selects the shared team library. Use the same hostname as the gallery. Your MCP
client must support OAuth: connect, complete provider sign-in in the browser, and
approve access when prompted. Client registration is handled by the OAuth flow;
you do not need to supply a client ID or secret for a supported public client.
Check the connection by asking your agent to list artifacts and scripts without
creating or changing anything.

**Local host:** `artifacts host` serves `http://127.0.0.1:4786` and
`http://127.0.0.1:4786/mcp` without sign-in in its default local configuration.
This bypass requires `ENVIRONMENT=local`, Access mode, and a loopback request
hostname. Better Auth always requires sign-in, including during local development.
For network deployments, follow the setup below and the
[celld deployment guide](celld-deployment.md).

### Which credential works where?

| Surface | Better Auth mode | Cloudflare Access mode |
| --- | --- | --- |
| Gallery and management routes such as `/api/tools` | Browser session cookie from provider sign-in | Valid signed Access assertion forwarded by Cloudflare |
| `/mcp` | OAuth access token issued by this deployment for its MCP resource | Managed OAuth token validated by Access, which forwards a signed assertion |
| Private app or script URL | Browser session, with the current owner's library permissions | Valid Access assertion, with the current owner's library permissions |
| Public app or script URL | No Artifacts sign-in; the handler can require application credentials | No Artifacts sign-in; the Access edge policy must also permit the path |

Artifacts does not currently issue personal API keys or support a client-credentials
grant for unattended management. In Better Auth mode, sending an MCP access token
to `/api/tools` does not authenticate that request: OAuth bearer authentication is
implemented only on `/mcp`. Use the MCP OAuth flow for programmatic management.
Provider access tokens and `BETTER_AUTH_SECRET` are not Artifacts API credentials.

In Better Auth mode, a custom MCP client should request the `artifacts` scope and
resource `https://artifacts.example.com/mcp`. The resource excludes library/workspace query
parameters. Discovery, authorization-code flow with PKCE, and refresh tokens are
supported. Access tokens expire after five minutes; clients should refresh them.
Signing out of the Better Auth session also invalidates its MCP access tokens.
Existing clients using the legacy `canvas` scope continue to work.
The `artifacts` scope does not distinguish read-only from write access. Clients
using DPoP-bound tokens must send the corresponding proof with each MCP request.

## Choose an authentication mode

| Mode | Use when | Required setup |
| --- | --- | --- |
| `better-auth` | You want provider sign-in hosted by Artifacts on Cloudflare or celld | Provider application, admission rule, deployment secret, and persistent `AUTH_DB` database with migrations |
| `access` | Cloudflare Access protects your deployment | Access application, user policy, managed OAuth for MCP, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD` |

The checked-in Wrangler configuration defaults to `access`. Set `AUTH_MODE`
explicitly for your deployment. Missing Access configuration returns 503 outside
the local bypass. Better Auth permits provider sign-in only; email/password
registration is disabled.

## Set up Better Auth

The following commands run from the repository root for a Cloudflare deployment.
For celld, use the same provider and admission settings, with the runtime-specific
database and deployment steps in [Configure celld](#configure-celld).

### 1. Choose the public origin and who can sign in

Merge these values into `vars` in `wrangler.jsonc`, replacing the example hostname
and email domain:

```json
{
  "ENVIRONMENT": "production",
  "AUTH_MODE": "better-auth",
  "BETTER_AUTH_URL": "https://artifacts.example.com",
  "BETTER_AUTH_ALLOWED_DOMAINS": "example.com",
  "BETTER_AUTH_TRUSTED_IP_HEADER": "cf-connecting-ip"
}
```

`BETTER_AUTH_URL` must be the stable HTTPS origin users and clients actually open,
without a path, query, or fragment. HTTP is allowed only on loopback development
hosts. If you also configure `ARTIFACTS_PUBLIC_ORIGIN` for generated links, use the
same external origin; that setting does not configure authentication.

Configure at least one admission rule:

| Setting | Admits |
| --- | --- |
| `BETTER_AUTH_ALLOWED_EMAILS` | Exact email addresses, separated by commas or whitespace |
| `BETTER_AUTH_ALLOWED_DOMAINS` | Exact email domains, separated by commas or whitespace |
| `BETTER_AUTH_ALLOW_ALL_USERS="true"` | Every identity authenticated by the configured providers |

Email/domain matches are case-insensitive and require a verified provider email.
Either allowlist may admit a user; domain rules do not implicitly include subdomains.
With no admission rule, nobody is admitted. Use allow-all only when the provider
already enforces your intended membership boundary. Provider hints such as Google's
hosted domain do not replace Artifacts admission rules.

### 2. Register an identity provider

Create an OAuth application with your identity provider. Register the callback
matching its configured provider ID:

```text
https://artifacts.example.com/api/auth/callback/google
https://artifacts.example.com/api/auth/callback/github
https://artifacts.example.com/api/auth/callback/company
```

For Google or GitHub, store `BETTER_AUTH_SOCIAL_PROVIDERS` as a Worker secret
containing JSON in Better Auth's native provider format. Choose one or combine both:

```json
{
  "google": { "clientId": "<google-client-id>", "clientSecret": "<google-client-secret>" },
  "github": { "clientId": "<github-client-id>", "clientSecret": "<github-client-secret>" }
}
```

```sh
bun x wrangler secret put BETTER_AUTH_SOCIAL_PROVIDERS
```

Paste the provider JSON at the prompt. Other social providers supported by the
installed Better Auth version use the same setting.

For a discovery-based OpenID Connect provider, store this JSON array in
`BETTER_AUTH_OIDC_PROVIDERS` instead. The `company` provider ID corresponds to the
third callback above:

```json
[
  {
    "providerId": "company",
    "name": "Company SSO",
    "discoveryUrl": "https://id.example.com/.well-known/openid-configuration",
    "clientId": "<oidc-client-id>",
    "clientSecret": "<oidc-client-secret>",
    "scopes": ["openid", "profile", "email"],
    "requireIdTokenVerification": true
  }
]
```

```sh
bun x wrangler secret put BETTER_AUTH_OIDC_PROVIDERS
```

Both provider settings can coexist. The sign-in page discovers configured
providers; it has no fixed provider list. For custom profile mapping, callbacks,
or additional provider plugins, extend
[`teamProviderOptions`](../cloudflare/team-auth.ts) in ordinary TypeScript.

### 3. Store the deployment secret

Generate a deployment-specific secret, then paste it at Wrangler's prompt:

```sh
openssl rand -base64 32
bun x wrangler secret put BETTER_AUTH_SECRET
```

The secret must contain at least 32 random characters. Keep it and provider
credentials out of committed configuration. Better Auth encrypts stored provider
access and refresh tokens and manages its RS256 signing keys in `AUTH_DB`.

### 4. Create and migrate the auth database

Create the database once:

```sh
bun x wrangler d1 create artifacts-auth --binding AUTH_DB
```

Add its returned ID to the `d1_databases` array in `wrangler.jsonc`:

```json
{
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "artifacts-auth",
      "database_id": "<database-id-returned-by-wrangler>",
      "migrations_dir": "cloudflare/migrations"
    }
  ]
}
```

Apply migrations before serving Better Auth traffic, then deploy:

```sh
bun x wrangler d1 migrations apply AUTH_DB --remote
bun run deploy:cloudflare
```

This database stores users, sessions, OAuth grants, signing keys, and auth rate
limits. It is separate from each artifact's runtime SQLite database. Startup does
not automatically detect or repair a missing or outdated auth schema.

### 5. Verify browser and MCP access

Open the configured public origin and sign in with an admitted account. Then
connect an OAuth-capable MCP client using the URLs in
[Connect to an existing deployment](#connect-to-an-existing-deployment).
An unauthenticated `/mcp` request should return 401 with a `WWW-Authenticate`
challenge pointing to this deployment's resource metadata:

```sh
curl -i https://artifacts.example.com/mcp
```

A successful `/health` response checks the runtime only; it does not verify auth
configuration, database migrations, or access to your library.

### Local Better Auth development

Keep the `AUTH_DB` binding above and apply migrations to workerd's local database:

```sh
bun x wrangler d1 migrations apply AUTH_DB --local
```

Create an ignored `.dev.vars` file with these settings, substituting real local
provider credentials and a generated secret:

```dotenv
AUTH_MODE="better-auth"
BETTER_AUTH_URL="http://127.0.0.1:4785"
BETTER_AUTH_SECRET="<generated-secret-at-least-32-characters>"
BETTER_AUTH_ALLOWED_EMAILS="you@example.com"
BETTER_AUTH_SOCIAL_PROVIDERS='{"github":{"clientId":"<client-id>","clientSecret":"<client-secret>"}}'
```

Register `http://127.0.0.1:4785/api/auth/callback/github` with that provider, then
run `bun run dev:cloudflare`. Use this exact host and port for the gallery, MCP,
and callback; `localhost` and `127.0.0.1` are different origins.

## Set up Cloudflare Access

1. Protect every hostname that reaches the Worker, including `workers.dev`,
   custom domains, and preview URLs. Cover the gallery, assets, and `/mcp`.
2. Configure an identity provider and an Access policy admitting the intended
   users. Cloudflare account membership and Artifacts access are separate.
3. Enable [Access managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
   for the application so MCP clients can complete OAuth sign-in. In Zero Trust,
   open **Access controls > Applications**, edit the application, and enable
   **Managed OAuth** under **Advanced settings**. Allow the redirect URIs used by
   your clients, including localhost/loopback callbacks for desktop clients.
4. Set these `vars` in `wrangler.jsonc`, then redeploy:

```json
{
  "ENVIRONMENT": "production",
  "AUTH_MODE": "access",
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "<access-application-audience>"
}
```

The domain and audience are identifiers, not secrets. Access mode needs no
`AUTH_DB` or Better Auth provider configuration. Artifacts verifies the forwarded
`Cf-Access-Jwt-Assertion` signature, issuer, audience, subject, and expiry. Managed
OAuth resolves the client's token at Cloudflare's edge; Artifacts does not validate
that opaque token itself. An arbitrary bearer token or caller-supplied identity
header cannot replace the signed assertion.

## Configure celld

Use the [celld deployment guide](celld-deployment.md) for preparing the Worker,
deploying to bucket storage, and running nodes. Better Auth uses the same public
origin, providers, secret, and admission rules on celld. Configure a persistent
`AUTH_DB` D1-compatible binding and apply the checked-in SQL migrations to that
runtime's database before enabling traffic. Wrangler's `--remote` command above
migrates Cloudflare D1; it does not migrate celld storage.

Generated celld configs carry an `AUTH_DB` binding from `wrangler.jsonc`, but set
`ENVIRONMENT=local` for development. Set it to `production` in the prepared
deployment config. `artifacts host` is the loopback development host; it does not
provision a production fleet or configure provider sign-in for you.

Access mode requires Cloudflare Access in front of celld and a verified assertion
on protected requests. A different reverse proxy does not automatically supply
that credential. For Better Auth, set `BETTER_AUTH_TRUSTED_IP_HEADER` only to a
header your trusted proxy replaces. Otherwise omit it; auth requests share a
per-path rate-limit bucket instead of trusting caller-supplied IP headers.

Keep the prepared project's `migrations_dir` inside that project and copy
`cloudflare/migrations` there. After deploying the configured Worker and starting
a node, apply its auth migrations before admitting application traffic. Follow
celld 0.5.0's [D1 operations reference](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md#operate-d1-and-kv)
for the migration command and bucket configuration.

`dev:celld` does not apply local auth migrations. celld's migration command targets
deployed bucket storage, and workerd's local D1 is a separate database. Use the
[workerd local setup](#local-better-auth-development) for routine auth development;
the celld auth integration fixture bootstraps its own temporary schema.

## Library and URL permissions

**Personal libraries** are private to the verified user. **Team library** content
can be read and edited by every user admitted to the deployment. There are no
separate team viewer/editor roles. `workspace` organizes content inside a library;
it does not grant access. Each deployment represents one team. Infrastructure
administrators can still administer the underlying storage.

**Private URLs** use the item's current library ownership. **Public URLs** allow
external callers to view an app or invoke a script, without granting management
access to its source. Public scripts can verify an application bearer token or
webhook signature using their stored secrets. The gateway strips management
cookies and Access credentials before calling user code; private routes also
strip the management authorization header. See [script access](scripts.md#access).

If Access protects the entire hostname, add an edge bypass for the specific public
paths you want external callers to reach. Setting a link to public does not
override Cloudflare's policy. Keep management paths protected.

Moving an item between personal and team libraries preserves its data, secrets,
schedule, and URL; its public/private URL setting remains unchanged. Management
and private-URL permissions follow the new owner.

## Troubleshooting

| Symptom | Check or next action |
| --- | --- |
| Access mode returns 503 | Set `ACCESS_TEAM_DOMAIN` to the complete `*.cloudflareaccess.com` domain and `ACCESS_AUD` to the correct application's audience; redeploy. |
| Access mode returns 401 or an edge login page instead of MCP | Confirm Access covers the exact hostname and `/mcp`, and managed OAuth is enabled. Artifacts needs a signed assertion from the edge. |
| Better Auth returns 503 / authentication unavailable | Check `AUTH_DB`, applied migrations, the public origin, the deployment secret, and provider JSON. Server logs contain initialization details. |
| The sign-in page has no providers | Configure `BETTER_AUTH_SOCIAL_PROVIDERS` or `BETTER_AUTH_OIDC_PROVIDERS`; for OIDC, check discovery availability and verification metadata. |
| Provider rejects the redirect URI | Match the public origin and `/api/auth/callback/<provider-id>` exactly, including the local host and port. |
| Provider sign-in succeeds but Artifacts denies access | Check admission rules and whether the provider reports a verified email. With no admission rule, nobody is admitted. |
| Gallery works but MCP returns 401 | Complete the MCP client's OAuth flow. A browser session cookie is not an MCP bearer token. Reconnect if its attached session expired or was signed out. |
| MCP returns 403 `insufficient_scope` | Request `artifacts` scope and the canonical `/mcp` resource, then authorize again. |
| MCP token does not work on `/api/tools` or a private URL | These routes use browser sessions in Better Auth mode. Use `/mcp` for OAuth programmatic management. |
| A public URL still prompts for Access sign-in | Add an Access bypass for that public path. The Artifacts link setting cannot override the edge. |
| Management requests return 403 `Origin is not allowed` | Use the deployment's own origin. The management API rejects cross-origin browser requests. |
| My personal library looks empty after changing auth mode | Private identities differ between Access and Better Auth; see the migration note below. |

## Changing authentication modes and upgrading

Switching modes does not migrate personal libraries. Access identities use their
issuer and subject; Better Auth identities use its user ID. Existing data is
retained, but the application does not infer that two identities are the same
person. Plan an explicit data migration if users need to retain their personal
libraries. The shared team-library key stays unchanged, so users admitted under
the new mode can access the existing team content.
Use separate deployments and admission policies for unrelated teams.

Apply future auth schema migrations with the runtime's migration tooling before
serving the updated code. Keep migration history; do not regenerate the initial
migration to replace it. Maintainers can generate a new schema delta with
`bun run scripts/generate-auth-migration.ts cloudflare/migrations/0002_description.sql`.
Authentication configuration and token verification live in
[`better-auth.ts`](../cloudflare/better-auth.ts); Access verification lives in
[`auth.ts`](../cloudflare/auth.ts).
