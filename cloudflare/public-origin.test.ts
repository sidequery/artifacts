import { expect, test } from "bun:test";
import { publicOrigin } from "./public-origin";
import { authenticate } from "./auth";

test("canonical links preserve local authentication behind a proxy", async () => {
  const request = new Request("http://127.0.0.1:4788/api/gallery", {headers:{"x-forwarded-host":"attacker.example"}});
  expect(publicOrigin(request.url, "https://artifacts.example")).toBe("https://artifacts.example");
  expect(await authenticate(request, {ENVIRONMENT:"local"})).toEqual({subject:"local",authority:"local"});
  expect(publicOrigin(request.url)).toBe("http://127.0.0.1:4788");
});

test("configured origins cannot inject paths, credentials, or policy text", () => {
  for (const origin of ["https://example.com/", "https://example.com/path", "https://user@example.com", "https://example.com?x", "https://example.com#x", "data:text/plain,x", 'https://foo"bar', "https://foo;bar", "https://example.com\n", ""]) {
    expect(() => publicOrigin("http://localhost/", origin)).toThrow();
  }
  expect(publicOrigin("http://localhost/", "http://example.com:4000")).toBe("http://example.com:4000");
});
