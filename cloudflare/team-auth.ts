import type { BetterAuthOptions } from "better-auth";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

export type TeamAuthEnvironment = {
  BETTER_AUTH_SOCIAL_PROVIDERS?: string;
  BETTER_AUTH_OIDC_PROVIDERS?: string;
  BETTER_AUTH_ALLOWED_EMAILS?: string;
  BETTER_AUTH_ALLOWED_DOMAINS?: string;
  BETTER_AUTH_ALLOW_ALL_USERS?: string;
};

function configuredJson(value: string | undefined, name: string, fallback: unknown): unknown {
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

function list(value?: string): string[] {
  return (value ?? "").split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
}

/** Admission belongs to the team deployment, independently of its provider.
 * Public providers need an email/domain policy; tenant-restricted providers can
 * explicitly admit all identities their configured provider authenticates. */
export function teamAllowsUser(env: TeamAuthEnvironment, user: { email?: unknown; emailVerified?: unknown }): boolean {
  if (env.BETTER_AUTH_ALLOW_ALL_USERS === "true") return true;
  if (user.emailVerified !== true || typeof user.email !== "string") return false;
  const email = user.email.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return false;
  return list(env.BETTER_AUTH_ALLOWED_EMAILS).includes(email)
    || list(env.BETTER_AUTH_ALLOWED_DOMAINS).includes(email.slice(email.lastIndexOf("@") + 1));
}

/** This is the deployment's native Better Auth provider configuration seam.
 * JSON options pass through to Better Auth unchanged. Teams needing callbacks
 * or additional provider plugins can configure them here in ordinary TypeScript;
 * the Canvas server and provider picker do not enumerate provider IDs. */
export function teamProviderOptions(env: TeamAuthEnvironment) {
  const social = configuredJson(env.BETTER_AUTH_SOCIAL_PROVIDERS, "BETTER_AUTH_SOCIAL_PROVIDERS", {});
  const oidc = configuredJson(env.BETTER_AUTH_OIDC_PROVIDERS, "BETTER_AUTH_OIDC_PROVIDERS", []);
  if (!social || typeof social !== "object" || Array.isArray(social)) throw new Error("BETTER_AUTH_SOCIAL_PROVIDERS must be an object of Better Auth provider options");
  if (!Array.isArray(oidc)) throw new Error("BETTER_AUTH_OIDC_PROVIDERS must be an array of Better Auth generic OAuth provider options");
  return {
    socialProviders: social as BetterAuthOptions["socialProviders"],
    plugins: oidc.length ? [genericOAuth({ config: oidc as GenericOAuthConfig[] })] : [],
  } satisfies Pick<BetterAuthOptions, "socialProviders" | "plugins">;
}
