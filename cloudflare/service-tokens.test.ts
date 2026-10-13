import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { servicePrincipal, serviceTokenDigests } from "./service-tokens";
import { ArtifactAuthConfigurationError } from "./better-auth";

const token = "service-token-test-only-value-with-enough-entropy";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const env = { ARTIFACTS_SERVICE_TOKENS: JSON.stringify({ "slack-bot": digest(token), "nightly-sync": digest("another-test-only-token") }) };

test("a configured service token resolves to its named principal only as a bearer credential", () => {
  expect(servicePrincipal(`Bearer ${token}`, env)).toEqual({ name: "slack-bot" });
  expect(servicePrincipal(`bearer ${token}`, env)).toEqual({ name: "slack-bot" });
  expect(servicePrincipal("Bearer another-test-only-token", env)).toEqual({ name: "nightly-sync" });
  for (const authorization of [null, undefined, "", token, `DPoP ${token}`, `Basic ${token}`, `Bearer ${token} extra`, `Bearer ${token}x`, `Bearer ${digest(token)}`]) {
    expect(servicePrincipal(authorization, env)).toBeNull();
  }
});

test("deployments without service tokens never resolve a service principal", () => {
  expect(servicePrincipal(`Bearer ${token}`, {})).toBeNull();
  expect(servicePrincipal(`Bearer ${token}`, { ARTIFACTS_SERVICE_TOKENS: "{}" })).toBeNull();
});

test("a malformed service token table is a configuration error rather than an empty table", () => {
  const invalid = [
    "{", "[]", "null", JSON.stringify({ "Slack Bot": digest(token) }), JSON.stringify({ "-bot": digest(token) }),
    JSON.stringify({ bot: token }), JSON.stringify({ bot: digest(token).toUpperCase() }), JSON.stringify({ bot: 1 }),
    JSON.stringify({ first: digest(token), second: digest(token) }),
  ];
  for (const value of invalid) {
    expect(() => serviceTokenDigests({ ARTIFACTS_SERVICE_TOKENS: value })).toThrow(ArtifactAuthConfigurationError);
    // Even a request without a token reports the misconfiguration.
    expect(() => servicePrincipal(null, { ARTIFACTS_SERVICE_TOKENS: value })).toThrow(ArtifactAuthConfigurationError);
  }
});
