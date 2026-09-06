import { expect, test } from "bun:test";

import { parseArgs } from "./args";

test("parseArgs defaults to help", () => {
  expect(parseArgs([])).toEqual({ command: "help", positionals: [], flags: {} });
});

test("parseArgs captures flags and positionals", () => {
  expect(parseArgs(["open", "billing", "--dir", "/tmp/canvases", "--no-open"])).toEqual({
    command: "open",
    positionals: ["billing"],
    flags: { dir: "/tmp/canvases", "no-open": true },
  });
});

test("parseArgs supports equals flags", () => {
  expect(parseArgs(["serve", "--port=8123"])).toEqual({
    command: "serve",
    positionals: [],
    flags: { port: "8123" },
  });
});
