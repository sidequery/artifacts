import { expect, test } from "bun:test";

import { ArtifactService } from "./service";
import { VALID_ARTIFACT, tempDir } from "./test/fixtures";

test("ArtifactService write typechecks and list returns the file", () => {
  const dir = tempDir();
  const service = new ArtifactService({ artifactsDir: dir, cwd: dir });
  const written = service.write("overview", VALID_ARTIFACT);
  expect(written.ok).toBe(true);
  expect(written.check).toBe("Artifact TypeScript check: no errors");
  expect(service.list().map((item) => item.id)).toEqual(["overview"]);
});

test("ArtifactService compile reports bytes for a valid artifact", async () => {
  const dir = tempDir();
  const service = new ArtifactService({ artifactsDir: dir, cwd: dir });
  service.write("overview", VALID_ARTIFACT);
  const compiled = await service.compile("overview");
  expect(compiled.ok).toBe(true);
  expect(compiled.js?.length).toBeGreaterThan(100);
});
