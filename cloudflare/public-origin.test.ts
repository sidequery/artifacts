import { expect, test } from "bun:test";
import { publicOrigin } from "./public-origin";

test("hosted links use the configured origin while local defaults remain request based", () => {
  expect(publicOrigin("http://127.0.0.1:4786/api/tools")).toBe("http://127.0.0.1:4786");
  expect(publicOrigin("http://127.0.0.1:4786/api/tools", "https://canvas.example/")).toBe("https://canvas.example");
  for (const invalid of ["", "http://canvas.example", "https://user:password@canvas.example", "https://canvas.example/path", "https://canvas.example/?x=1", "https://canvas.example/#x"]) {
    expect(() => publicOrigin("http://127.0.0.1:4786", invalid)).toThrow();
  }
});
