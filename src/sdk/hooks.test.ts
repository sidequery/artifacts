import { expect, test } from "bun:test";

import { getArtifactCapabilities, themeKindFromHost, type HostBridge } from "./hooks";

test("capability discovery reports installed runtime bridges without executing them", () => {
  const host = globalThis as typeof globalThis & { __artifacts?: HostBridge };
  const previous = host.__artifacts;
  let calls = 0;
  try {
    delete host.__artifacts;
    expect(getArtifactCapabilities()).toEqual({ server: false, files: false, plugins: false, hostActions: false, statePersistence: "session" });
    host.__artifacts = { onRequest: async () => { calls++; throw new Error("should not execute"); }, onFileRequest: async () => { calls++; }, onPluginCall: async () => { calls++; }, onAction: () => { calls++; } };
    expect(getArtifactCapabilities()).toEqual({ server: true, files: true, plugins: true, hostActions: true, statePersistence: "session" });
    host.__artifacts = { actionUrl: "/action", persistUrl: "/state" };
    expect(getArtifactCapabilities()).toMatchObject({ hostActions: true, statePersistence: "persistent", server: false });
    expect(calls).toBe(0);
  } finally { if (previous) host.__artifacts = previous; else delete host.__artifacts; }
});

test("themeKindFromHost honors an explicit dark host theme", () => {
  expect(themeKindFromHost("dark", true)).toBe("dark");
  expect(themeKindFromHost("light", false)).toBe("light");
});

test("themeKindFromHost falls back to the OS preference", () => {
  expect(themeKindFromHost(undefined, true)).toBe("light");
  expect(themeKindFromHost("auto", false)).toBe("dark");
});
