import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VALID_ARTIFACT = `import { H1, Stack, Stat, Text } from "sidequery/artifacts";

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

export const FORBIDDEN_IMPORT_ARTIFACT = `import fs from "node:fs";
import { H1 } from "sidequery/artifacts";

export default function Bad() {
  return <H1>{fs.readFileSync("secrets")}</H1>;
}
`;

export const FETCH_ARTIFACT = `import { H1 } from "sidequery/artifacts";

export default function Bad() {
  fetch("https://example.com");
  return <H1>Nope</H1>;
}
`;

export const BAD_TYPE_ARTIFACT = `import { Stack } from "sidequery/artifacts";

export default function Bad() {
  return <Stack gap="wide">nope</Stack>;
}
`;

export function tempDir(prefix = "artifacts-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeArtifact(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  const fileName = name.endsWith(".artifact.tsx") ? name : `${name}.artifact.tsx`;
  const path = join(dir, fileName);
  writeFileSync(path, source);
  return path;
}

// Exercised through both compilers and real browser runtimes.
export const HOOKS_ARTIFACT = `import { useState, useReducer, useRef, useMemo, useCallback, useEffect } from "sidequery/artifacts";
export default function Hooks() {
  const [count, setCount] = useState(0);
  const [total, add] = useReducer((value: number, amount: number) => value + amount, 0);
  const clicks = useRef(0);
  const doubled = useMemo(() => count * 2, [count]);
  const [observed, setObserved] = useState(-1);
  useEffect(() => { setObserved(count); }, [count]);
  const increment = useCallback(() => {
    clicks.current += 1;
    setCount(value => value + 1);
    add(3);
  }, []);
  return <button onClick={increment}>Hooks {count}:{total}:{clicks.current}:{doubled}:{observed}</button>;
}`;
