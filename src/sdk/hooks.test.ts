import { expect, test } from "bun:test";

import { themeKindFromHost } from "./hooks";

test("themeKindFromHost honors an explicit dark host theme", () => {
  expect(themeKindFromHost("dark", true)).toBe("dark");
  expect(themeKindFromHost("light", false)).toBe("light");
});

test("themeKindFromHost falls back to the OS preference", () => {
  expect(themeKindFromHost(undefined, true)).toBe("light");
  expect(themeKindFromHost("auto", false)).toBe("dark");
});
