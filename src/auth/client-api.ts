import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  // The sign-in and consent screens own navigation after inspecting errors.
  disableDefaultFetchPlugins: true,
  plugins: [oauthProviderClient()],
});

export function safeReturnTo(search = window.location.search): string {
  const raw = new URLSearchParams(search).get("returnTo");
  if (!raw) return "/";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function signInUrl(returnTo = window.location.href): string {
  let safe = "/";
  try {
    const url = new URL(returnTo, window.location.origin);
    if (url.origin === window.location.origin) safe = `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Keep the root fallback for malformed input.
  }
  const url = new URL("/sign-in", window.location.origin);
  url.searchParams.set("returnTo", safe);
  return `${url.pathname}${url.search}`;
}
