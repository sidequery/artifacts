#!/usr/bin/env bun

import { canvasesDirFrom } from "../canvasFile";
import { createHerdrClient } from "../herdr";
import { CanvasService } from "../service";

const name = process.argv[2] ?? process.env.HERDR_CANVAS_NAME;
if (!name) {
  console.error("missing canvas name");
  process.exit(1);
}

const service = new CanvasService({
  canvasesDir: canvasesDirFrom(process.cwd()),
  herdr: createHerdrClient(),
});
const result = await service.open(name);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exit(1);
}
