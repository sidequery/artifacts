import { expect, test } from "bun:test";

import { CanvasService } from "./service";
import { VALID_CANVAS, tempDir } from "./test/fixtures";

test("CanvasService write typechecks and list returns the file", () => {
  const dir = tempDir();
  const service = new CanvasService({ canvasesDir: dir, cwd: dir });
  const written = service.write("overview", VALID_CANVAS);
  expect(written.ok).toBe(true);
  expect(written.check).toBe("Canvas TypeScript check: no errors");
  expect(service.list().map((item) => item.id)).toEqual(["overview"]);
});

test("CanvasService compile reports bytes for a valid canvas", async () => {
  const dir = tempDir();
  const service = new CanvasService({ canvasesDir: dir, cwd: dir });
  service.write("overview", VALID_CANVAS);
  const compiled = await service.compile("overview");
  expect(compiled.ok).toBe(true);
  expect(compiled.js?.length).toBeGreaterThan(100);
});
