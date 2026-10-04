// Bump to refresh cached shells; keep older tool-result payloads readable.
const ARTIFACTS_APP_VERSION = 6;
export const ARTIFACTS_APP_URI = `ui://artifacts/v${ARTIFACTS_APP_VERSION}/viewer.html`;

/** Saved chat cards keep their original URI across compatible shell updates. */
export function isArtifactAppUri(uri: unknown): uri is string {
  if (uri === "ui://artifacts/viewer.html") return true;
  if (typeof uri !== "string") return false;
  const version = /^ui:\/\/artifacts\/v([1-9]\d*)\/viewer\.html$/.exec(uri)?.[1];
  return version !== undefined && Number(version) <= ARTIFACTS_APP_VERSION;
}
export const ARTIFACTS_APP_MIME = "text/html;profile=mcp-app";
export const ARTIFACTS_APP_META = { ui: { resourceUri: ARTIFACTS_APP_URI } };
export const ARTIFACTS_RESOURCE = {
  uri: ARTIFACTS_APP_URI, name: "Artifacts", mimeType: ARTIFACTS_APP_MIME,
  _meta: {
    ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
  },
};

export type ArtifactAppPayload = {
  name: string; versionId: string; eventId: string; sourceHash: string;
  js: string; state: Record<string, unknown>; server?: boolean;
  plugins?: boolean;
  files?: boolean;
  workspace?: string;
  revision?: number;
};
