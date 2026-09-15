import { expect, test } from "bun:test";
import { scriptRuntimeConfig } from "./script-runtime";

test("only an explicit celld deployment omits unsupported script limits", () => {
  for (const runtime of [undefined, "cloudflare", "", "unknown"]) {
    expect(scriptRuntimeConfig(runtime).limits).toEqual({ cpuMs: 30000, subRequests: 50 });
  }
  expect(scriptRuntimeConfig("celld")).not.toHaveProperty("limits");
  expect(scriptRuntimeConfig("celld").compatibilityFlags).toContain("nodejs_compat");
});
