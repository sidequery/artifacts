export type Diagnostic = {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
};

export function formatArtifactCheck(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) {
    return "Artifact TypeScript check: no errors";
  }
  const header = `Artifact TypeScript check: ${errors.length} error${errors.length === 1 ? "" : "s"}`;
  const body = errors.map(formatDiagnosticLine);
  return [header, ...body].join("\n");
}

export function formatDiagnosticLine(diagnostic: Diagnostic): string {
  const location = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}`
    : undefined;
  return location ? `${location} - ${diagnostic.message}` : diagnostic.message;
}

export function sandboxToDiagnostics(file: string, violations: Array<{ message: string; line?: number }>): Diagnostic[] {
  return violations.map((violation) => ({
    severity: "error" as const,
    message: violation.message,
    file,
    line: violation.line,
  }));
}
