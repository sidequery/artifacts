import { createHash } from "node:crypto";

// Older generated links remain valid but are never issued for new URLs.
export function legacyUsername(owner: string) {
  return "user-" + createHash("sha256").update(owner).digest("hex").slice(0, 32);
}

export function emailUsername(email?: string) {
  const at = email?.lastIndexOf("@") ?? -1;
  const prefix = email && at > 0 ? email.slice(0, at).toLowerCase() : "";
  const base = prefix.replace(/[^a-z0-9._+-]+/g, "-").slice(0, 64);
  return /[a-z0-9]/.test(base) ? base : "user";
}

export function nativeAppPath(username: string | null, workspace: string, name: string) {
  // Browsers collapse even percent-encoded dot segments. Escape the prefix too.
  const segment = /^(?:\.{1,2}$|~)/.test(workspace) ? "~" + workspace : workspace;
  const prefix = username === null ? "/team" : "/users/" + username;
  return `${prefix}/${encodeURIComponent(segment)}/${encodeURIComponent(name)}/`;
}

export function matchNativeAppPath(pathname: string) {
  return /^\/(?:team|users\/(?<username>[^/]+))\/(?<workspace>[^/]+)\/(?<name>[^/]+)(?<path>\/.*)?$/.exec(pathname)?.groups;
}

export function workspaceFromPath(segment: string) {
  const workspace = decodeURIComponent(segment);
  return /^~(?:\.{1,2}$|~)/.test(workspace) ? workspace.slice(1) : workspace;
}
