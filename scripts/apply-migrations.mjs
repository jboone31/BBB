/**
 * One-off migration applier for the BBB Supabase project.
 *
 * Applies every `supabase/migrations/NNNN_*.sql` file in ascending numeric
 * order against SUPABASE_DB_URL (loaded from .env.local), using the same
 * `postgres` (postgres.js) driver the app uses. Each migration file already
 * wraps its own statements in `begin; ... commit;`, so we send each file as one
 * multi-statement request via `sql.unsafe(...)`.
 *
 * Idempotency: the migrations use `create extension if not exists`, but the
 * `create table` / `create type` statements are NOT guarded, so re-applying a
 * migration that already ran will error ("already exists"). This script is
 * intended for a fresh project. Run once.
 *
 * Usage:  node scripts/apply-migrations.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("ERROR: SUPABASE_DB_URL is not set (checked .env.local).");
  process.exit(1);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));

if (files.length === 0) {
  console.error("ERROR: no migration files found in supabase/migrations.");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });

let applied = 0;
try {
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`Applying ${file} ... `);
    try {
      await sql.unsafe(body);
      applied += 1;
      console.log("OK");
    } catch (err) {
      console.log("FAILED");
      console.error(`\n  ${file}: ${err.message}\n`);
      throw err;
    }
  }
  console.log(`\nDone. Applied ${applied}/${files.length} migrations.`);
} catch {
  console.error(
    `\nStopped after ${applied} migration(s). Fix the error above and re-run ` +
      `(note: migrations are not individually idempotent — a partially applied ` +
      `project may need manual cleanup or a fresh database).`,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
