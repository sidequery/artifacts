export type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | true>;
};

export function parseArgs(raw: string[]): ParsedArgs {
  const [command = "help", ...rest] = raw;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 1;
        continue;
      }
      flags[key] = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 1;
        continue;
      }
      flags[key] = true;
      continue;
    }
    positionals.push(arg);
  }

  return { command, positionals, flags };
}

export function flagString(flags: Record<string, string | true>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function flagBoolean(flags: Record<string, string | true>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}
