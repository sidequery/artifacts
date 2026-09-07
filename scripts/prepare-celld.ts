import { resolve } from "node:path";

const supportedKeys = new Set([
  "$schema",
  "name",
  "main",
  "no_bundle",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
]);

export async function prepareCelldConfig(
  source = resolve(import.meta.dir, "../wrangler.jsonc"),
  output = resolve(import.meta.dir, "../wrangler.celld.jsonc"),
  paths: { main?: string; assets?: string } = {},
) {
  const canonical = Bun.JSONC.parse(await Bun.file(source).text()) as Record<string, unknown>;
  const config = Object.fromEntries(Object.entries(canonical).filter(([key]) => supportedKeys.has(key)));
  config.main = paths.main ?? "dist/worker-app/worker.js";
  if (config.assets && typeof config.assets === "object" && !Array.isArray(config.assets)) {
    config.assets = {
      ...(config.assets as Record<string, unknown>),
      directory: paths.assets ?? "./dist/cloudflare/assets",
    };
  }
  config.vars = { ...(config.vars as Record<string, unknown> | undefined), ENVIRONMENT: "local" };
  await Bun.write(output, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

if (import.meta.main) {
  const output = resolve(process.cwd(), process.argv[2] ?? "wrangler.celld.jsonc");
  await prepareCelldConfig(resolve(import.meta.dir, "../wrangler.jsonc"), output);
  console.log(`Wrote ${output}`);
}
