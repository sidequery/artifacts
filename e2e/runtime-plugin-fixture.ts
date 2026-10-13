import { definePlugin } from "@sidequery/artifacts/plugins";

const VERSION = "fixture-v1";

/** Published at runtime by cloudflare/runtime-plugins.test.ts. */
export default definePlugin({
  name: "test-warehouse",
  description: "Runtime plugin test fixture",
  secrets: ["PLUGIN_WAREHOUSE_TOKEN"],
  operations: {
    query: {
      description: "Echo a query with the caller and what this isolate can see",
      readOnly: true,
      inputSchema: { type: "object", properties: { sql: { type: "string", minLength: 1 } }, required: ["sql"], additionalProperties: false },
      outputSchema: { type: "object", required: ["sql", "user", "secrets", "version", "processEnv"] },
      handler(input: { sql: string }, { user, secrets }) {
        const processEnv = typeof process === "undefined" ? [] : Object.keys(process.env ?? {}).sort();
        return { sql: input.sql, user, secrets: { ...secrets }, version: VERSION, processEnv };
      },
    },
    restricted: {
      description: "Allowed for nobody",
      inputSchema: { type: "object" },
      authorize: user => user.subject === "nobody",
      handler: () => ({ reached: true }),
    },
    broken: {
      description: "Throws with provider details",
      inputSchema: { type: "object" },
      handler(_input, { secrets }) { throw new Error(`provider failed with ${secrets.PLUGIN_WAREHOUSE_TOKEN}`); },
    },
  },
});
