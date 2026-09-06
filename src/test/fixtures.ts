import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VALID_CANVAS = `import { H1, Stack, Stat, Text } from "herdr/canvas";

export default function Overview() {
  return (
    <Stack gap={16}>
      <H1>Overview</H1>
      <Text>Embedded sample data.</Text>
      <Stat value="12" label="Open issues" tone="danger" />
    </Stack>
  );
}
`;

export const FORBIDDEN_IMPORT_CANVAS = `import fs from "node:fs";
import { H1 } from "herdr/canvas";

export default function Bad() {
  return <H1>{fs.readFileSync("secrets")}</H1>;
}
`;

export const FETCH_CANVAS = `import { H1 } from "herdr/canvas";

export default function Bad() {
  fetch("https://example.com");
  return <H1>Nope</H1>;
}
`;

export const BAD_TYPE_CANVAS = `import { Stack } from "herdr/canvas";

export default function Bad() {
  return <Stack gap="wide">nope</Stack>;
}
`;

export function tempDir(prefix = "herdr-canvas-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeCanvas(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  const fileName = name.endsWith(".canvas.tsx") ? name : `${name}.canvas.tsx`;
  const path = join(dir, fileName);
  writeFileSync(path, source);
  return path;
}
