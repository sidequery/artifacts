import { OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/server";
import { ARTIFACTS_APP_URI } from "./app-contract";

/** Open only our owned format; ordinary TSX remains with the host's normal viewer. */
export const ARTIFACTS_FILE_TOOL = {
  name: "artifacts_file",
  title: "Artifact source editor",
  description: "View or explicitly edit an owned .artifact.tsx file using host-managed resource access. Opening a file does not execute, import, or publish its source.",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, pattern: "\\.artifact\\.tsx$" },
          resourceUri: { type: "string", minLength: 1 },
        },
        required: ["name", "resourceUri"],
        additionalProperties: false,
      },
    },
    required: ["file"],
    additionalProperties: false,
  },
  _meta: {
    ui: { resourceUri: ARTIFACTS_APP_URI, visibility: ["app"] },
    "openai/ui": { entrypoints: [{ type: "file", extensions: [".artifact.tsx"] }] },
  },
};

/** The server validates the envelope, but never resolves this opaque URI as a path. */
export function artifactFileResult(args: unknown) {
  const input = OpenAIFileEntrypointInputSchema.parse(args);
  if (!input.file.name.endsWith(".artifact.tsx") || !input.file.resourceUri.trim()) {
    throw new Error("A .artifact.tsx filename and nonblank host resource URI are required.");
  }
  return {
    content: [{ type: "text" as const, text: `Opened ${input.file.name} in the artifact source editor.` }],
    structuredContent: { file: input.file },
  };
}
