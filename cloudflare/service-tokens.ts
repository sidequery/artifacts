import { createHash, timingSafeEqual } from "node:crypto";
import { ArtifactAuthConfigurationError } from "./better-auth";

export type ServiceTokenEnvironment = { ARTIFACTS_SERVICE_TOKENS?: string };
/** An unattended MCP client admitted by deployment configuration rather than
 * provider sign-in. It has no Better Auth user, session or personal library. */
export type ServicePrincipal = { name: string };
export const SERVICE_TOKEN_AUTHORITY = "service-token";

const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Deployment variables are stored with the deployment record, so the table
 * holds token digests only: `{"<service name>": "<lowercase hex SHA-256>"}`.
 * A malformed table is a configuration error, never an empty table. */
export function serviceTokenDigests(env: ServiceTokenEnvironment): Map<string, Buffer> {
  const digests = new Map<string, Buffer>();
  if (!env.ARTIFACTS_SERVICE_TOKENS) return digests;
  let table: unknown;
  try { table = JSON.parse(env.ARTIFACTS_SERVICE_TOKENS); }
  catch { throw new ArtifactAuthConfigurationError("ARTIFACTS_SERVICE_TOKENS must contain valid JSON"); }
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    throw new ArtifactAuthConfigurationError("ARTIFACTS_SERVICE_TOKENS must be an object mapping service names to SHA-256 token digests");
  }
  const seen = new Set<string>();
  for (const [name, digest] of Object.entries(table)) {
    if (!SERVICE_NAME.test(name)) throw new ArtifactAuthConfigurationError(`ARTIFACTS_SERVICE_TOKENS has an invalid service name: ${JSON.stringify(name)}`);
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) throw new ArtifactAuthConfigurationError(`ARTIFACTS_SERVICE_TOKENS entry ${name} must be a lowercase hex SHA-256 token digest`);
    if (seen.has(digest)) throw new ArtifactAuthConfigurationError("ARTIFACTS_SERVICE_TOKENS digests must be unique");
    seen.add(digest);
    digests.set(name, Buffer.from(digest, "hex"));
  }
  return digests;
}

/** Resolve a `Bearer` service token. Null means "not a service token", so
 * OAuth access-token verification proceeds unchanged. */
export function servicePrincipal(authorization: string | null | undefined, env: ServiceTokenEnvironment): ServicePrincipal | null {
  const digests = serviceTokenDigests(env);
  if (!digests.size) return null;
  const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return null;
  const supplied = createHash("sha256").update(token).digest();
  for (const [name, digest] of digests) if (timingSafeEqual(supplied, digest)) return { name };
  return null;
}
