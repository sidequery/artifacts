export const CANVAS_APP_URI = "ui://canvas/viewer.html";
export const CANVAS_APP_MIME = "text/html;profile=mcp-app";
export const CANVAS_APP_META = { ui: { resourceUri: CANVAS_APP_URI } };
export const CANVAS_RESOURCE = {
  uri: CANVAS_APP_URI, name: "Canvas", mimeType: CANVAS_APP_MIME,
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
};

export type CanvasAppPayload = {
  name: string; versionId: string; eventId: string; sourceHash: string;
  js: string; state: Record<string, unknown>;
};
