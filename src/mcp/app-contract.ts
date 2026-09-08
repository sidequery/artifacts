export const ARTIFACTS_APP_URI = "ui://artifacts/viewer.html";
export const ARTIFACTS_APP_MIME = "text/html;profile=mcp-app";
export const ARTIFACTS_APP_META = { ui: { resourceUri: ARTIFACTS_APP_URI } };
export const ARTIFACTS_RESOURCE = {
  uri: ARTIFACTS_APP_URI, name: "Artifacts", mimeType: ARTIFACTS_APP_MIME,
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
};

export type ArtifactAppPayload = {
  name: string; versionId: string; eventId: string; sourceHash: string;
  js: string; state: Record<string, unknown>; server?: boolean;
  plugins?: boolean;
  files?: boolean;
};
