import { expect, test } from "bun:test";
import { parseArtifactDeepLink } from "./mcp-workspace";

test("deep links keep authenticated selectors and internal routes and reject external targets", () => {
  const query = new URLSearchParams({ workspace: "research", name: "dashboard", version_id: "saved-version", route: "/accounts/456?tab=details" });
  expect(parseArtifactDeepLink(`/artifact?${query}`)).toEqual({ workspace: "research", name: undefined, version_id: "saved-version", route: "/accounts/456?tab=details" });
  for (const target of ["https://external.example/artifact?name=dashboard", "/artifact", "/artifact?name=dashboard&route=//external.example", "http://[invalid"]) {
    expect(parseArtifactDeepLink(target)).toBeNull();
  }
});
