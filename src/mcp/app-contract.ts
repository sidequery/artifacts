// Bump this resource version for incompatible shell or payload changes. Hosts cache by URI.
export const ARTIFACTS_APP_URI = "ui://artifacts/v4/viewer.html";
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
