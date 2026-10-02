import type { ArtifactProject } from "../cloudflare/project";

export const PROJECT_ARCHIVE_FORMAT = "sidequery-artifacts-project";
export const MAX_PROJECT_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const PROJECT_IMPORT_REQUEST_BYTES = MAX_PROJECT_ARCHIVE_BYTES + 8192;
export type ProjectArchive = {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: 1;
  kind: "artifact" | "script";
  name: string;
  source: string;
  server_source: string | null;
  project: ArtifactProject;
};
export const PROJECT_ARCHIVE_SCHEMA = {
  type: "object", properties: {
    format: { const: PROJECT_ARCHIVE_FORMAT }, version: { const: 1 }, kind: { enum: ["artifact", "script"] },
    name: { type: "string", minLength: 1, maxLength: 255 }, source: { type: "string", maxLength: 262144 }, server_source: { type: ["string", "null"], maxLength: 262144 },
    project: { type: "object", properties: {
      files: { type: "object", maxProperties: 64, additionalProperties: { type: "string" } },
      dependencies: { type: "object", maxProperties: 32, additionalProperties: { type: "string" } },
      lock: { type: "object", maxProperties: 4096, additionalProperties: { type: "string" } },
    }, required: ["files", "dependencies", "lock"], additionalProperties: false },
  }, required: ["format", "version", "kind", "name", "source", "server_source", "project"], additionalProperties: false,
};
