import { definePlugins } from "../src/plugins/config";

/** Installed only by test:mcp-discovery, never by the default build. */
export default definePlugins([{
  name: "mcp-discovery-test", description: "Authenticated MCP dispatch fixture",
  operations: {
    echo: {
      description: "Echo a validated value for the authorized fixture user.", readOnly: true,
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      authorize: user => user.subject === "local",
      handler: (input: { value: string }) => ({ value: input.value }),
    },
  },
}]);
