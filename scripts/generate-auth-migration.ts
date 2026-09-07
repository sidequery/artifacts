import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { canvasAuthOptions } from "../cloudflare/better-auth";

const output = process.argv[2];
if (!output) throw new Error("Usage: bun run scripts/generate-auth-migration.ts <new-migration.sql>");
if (await Bun.file(output).exists()) throw new Error("Choose a new migration path; existing migrations are not overwritten");
const database = new Database(":memory:");
try {
  const migrationsDirectory = join(import.meta.dir, "../cloudflare/migrations");
  const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort();
  for (const migration of migrations) database.exec(await readFile(join(migrationsDirectory, migration), "utf8"));

  // Schema generation needs no real provider credentials or live auth database.
  const options = canvasAuthOptions({
    BETTER_AUTH_URL: "http://localhost:4785",
    BETTER_AUTH_SECRET: "schema-generation-only-not-an-authentication-secret",
  }, database);
  const changes = await getMigrations(options);
  const sql = await changes.compileMigrations();
  if (!sql.replace(/--.*$/gm, "").replace(/[;\s]/g, "")) throw new Error("No auth schema changes; no migration was written");
  await Bun.write(output, `-- Generated from Better Auth 1.7.3 and Canvas auth options.\n${sql.trim()}\n`);
  console.log(`Wrote ${output}`);
} finally { database.close(); }
