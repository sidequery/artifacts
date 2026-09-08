export type SandboxViolation = {
  kind: "import" | "api" | "export";
  message: string;
  line?: number;
};

const ALLOWED_MODULES = new Set(["sidequery/artifacts","@sidequery/artifacts","sidequery/canvas","@sidequery/canvas","herdr/canvas","cursor/canvas"]);

const IMPORT_FROM_RE = /(?:^|[;\n}])\s*(?:import|export)\s*(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;\n}])\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/;
const REQUIRE_RE = /\brequire\s*\(/;

const FORBIDDEN_APIS: Array<{ kind: SandboxViolation["kind"]; pattern: RegExp; message: string }> = [
  { kind: "api", pattern: /\bfetch\s*\(/, message: "fetch() is not allowed in artifact files; embed data inline" },
  { kind: "api", pattern: /\bXMLHttpRequest\b/, message: "XMLHttpRequest is not allowed in artifact files" },
  { kind: "api", pattern: /\bWebSocket\b/, message: "WebSocket is not allowed in artifact files" },
  { kind: "api", pattern: /\beval\s*\(/, message: "eval() is not allowed in artifact files" },
  { kind: "api", pattern: /\bnew\s+Function\b/, message: "new Function is not allowed in artifact files" },
  { kind: "api", pattern: /\bprocess\./, message: "Node process is not allowed in artifact files" },
  { kind: "api", pattern: /\bBun\./, message: "Bun APIs are not allowed in artifact files" },
  { kind: "api", pattern: /\blocalStorage\b/, message: "localStorage is not allowed; use useArtifactState" },
  { kind: "api", pattern: /\bsessionStorage\b/, message: "sessionStorage is not allowed; use useArtifactState" },
];

export function stripCommentsForScan(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\\n])\/\/.*$/gm, "$1");
}

export function scanArtifactSource(source: string, publicImports: readonly string[] = []): SandboxViolation[] {
  const stripped = stripCommentsForScan(source);
  const violations: SandboxViolation[] = [];

  for (const match of stripped.matchAll(IMPORT_FROM_RE)) {
    const specifier = match[1];
    if (!ALLOWED_MODULES.has(specifier) && !publicImports.includes(specifier)) {
      violations.push({
        kind: "import",
        message: `import from "${specifier}" is not allowed; import only from "sidequery/artifacts"`,
        line: lineNumberAt(stripped, match.index ?? 0),
      });
    }
  }

  for (const match of stripped.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    const specifier = match[1];
    if (!ALLOWED_MODULES.has(specifier) && !publicImports.includes(specifier)) {
      violations.push({
        kind: "import",
        message: `side-effect import of "${specifier}" is not allowed`,
        line: lineNumberAt(stripped, match.index ?? 0),
      });
    }
  }

  if (DYNAMIC_IMPORT_RE.test(stripped)) {
    violations.push({ kind: "import", message: "dynamic import() is not allowed in artifact files" });
  }
  if (REQUIRE_RE.test(stripped)) {
    violations.push({ kind: "import", message: "require() is not allowed in artifact files" });
  }

  for (const api of FORBIDDEN_APIS) {
    if (api.pattern.test(stripped)) {
      violations.push({ kind: api.kind, message: api.message });
    }
  }

  if (!/\bexport\s+default\b/.test(stripped)) {
    violations.push({
      kind: "export",
      message: "artifact files must default-export a React component",
    });
  }

  return uniqueViolations(violations);
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function uniqueViolations(violations: SandboxViolation[]): SandboxViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.kind}:${violation.message}:${violation.line ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
