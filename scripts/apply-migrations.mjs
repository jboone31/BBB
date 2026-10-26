/**
 * Migration applier for the BBB Supabase project.
 *
 * Applies every `supabase/migrations/NNNN_*.sql` file in ascending numeric order
 * against SUPABASE_DB_URL (loaded from .env.local), using the same `postgres`
 * (postgres.js) driver the app uses. Each migration file wraps its own
 * statements in `begin; ... commit;`, so each file is sent as one
 * multi-statement request via `sql.unsafe(...)`.
 *
 * Unlike the original one-shot version, this applier TRACKS which migrations
 * have run in a `schema_migrations` ledger table and SKIPS any already recorded,
 * so it is safe to re-run and will only apply migrations that are new since the
 * last run. The individual migration files are still not internally idempotent
 * (their `create table` / `create type` statements are unguarded), which is
 * exactly why the ledger exists: a migration is executed at most once.
 *
 * ---------------------------------------------------------------------------
 * Adopting an EXISTING database (first run of this version)
 * ---------------------------------------------------------------------------
 * A database migrated before this ledger existed already has its tables but no
 * ledger rows. Running normally would try to re-apply 0001 and fail
 * ("already exists"). To adopt such a database, BASELINE it once: record the
 * migrations that are already applied WITHOUT executing them.
 *
 *   node scripts/apply-migrations.mjs --baseline=<N>
 *
 * records 0001..000N as applied (no SQL from those files is run). After
 * baselining, future runs apply only files numbered above N. For the BBB
 * project as of migration 0012, the one-time adoption command is:
 *
 *   node scripts/apply-migrations.mjs --baseline=12
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   node scripts/apply-migrations.mjs                 # apply all un-applied migrations
 *   node scripts/apply-migrations.mjs --dry-run       # list what WOULD be applied, change nothing
 *   node scripts/apply-migrations.mjs --baseline=12   # record 0001..0012 as applied, run none
 *
 * Flags may be combined (e.g. `--baseline=12 --dry-run` previews the baseline).
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

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/** Parse CLI flags: `--dry-run` and `--baseline=<N>`. */
function parseArgs(argv) {
  let dryRun = false;
  let baseline = null;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--baseline=")) {
      const raw = arg.slice("--baseline=".length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        console.error(
          `ERROR: --baseline must be a non-negative integer (got "${raw}").`,
        );
        process.exit(1);
      }
      baseline = n;
    } else {
      console.error(`ERROR: unknown argument "${arg}".`);
      console.error(
        "Usage: node scripts/apply-migrations.mjs [--dry-run] [--baseline=<N>]",
      );
      process.exit(1);
    }
  }
  return { dryRun, baseline };
}

const { dryRun, baseline } = parseArgs(process.argv.slice(2));

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("ERROR: SUPABASE_DB_URL is not set (checked .env.local).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Migration file discovery
// ---------------------------------------------------------------------------

/** The numeric version prefix of a migration file name (e.g. "0012_x.sql" -> 12). */
function versionOf(fileName) {
  return Number(fileName.split("_")[0]);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort((a, b) => versionOf(a) - versionOf(b));

if (files.length === 0) {
  console.error("ERROR: no migration files found in supabase/migrations.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** The ledger table recording which migrations have been applied. */
const ENSURE_LEDGER_SQL = `
create table if not exists schema_migrations (
  version     integer primary key,
  name        text not null,
  applied_at  timestamptz not null default now()
)
`;

const sql = postgres(dbUrl, {
  max: 1,
  prepare: false,
  // Swallow non-error NOTICEs (e.g. "relation ... already exists, skipping"
  // from `create table if not exists`) so the run output stays clean.
  onnotice: () => {},
});

let applied = 0;
let skipped = 0;
let recorded = 0;

try {
  // The ledger itself is created idempotently (IF NOT EXISTS), so this is safe
  // to run on every invocation, including the first against an existing DB.
  await sql.unsafe(ENSURE_LEDGER_SQL);

  const ledgerRows = await sql`select version from schema_migrations`;
  const appliedVersions = new Set(ledgerRows.map((r) => Number(r.version)));

  if (baseline !== null) {
    // Baseline mode: record 0001..000N as applied WITHOUT running their SQL, so
    // an already-migrated database can adopt the ledger. Files already recorded
    // are left as-is; only missing versions <= N are inserted.
    console.log(
      `Baseline mode: recording migrations up to ${baseline} as applied ` +
        `(no SQL executed)${dryRun ? " [dry run]" : ""}.`,
    );
    for (const file of files) {
      const version = versionOf(file);
      if (version > baseline) continue;
      if (appliedVersions.has(version)) {
        console.log(`  ${file} ... already recorded`);
        continue;
      }
      if (dryRun) {
        console.log(`  ${file} ... WOULD record`);
        recorded += 1;
        continue;
      }
      await sql`
        insert into schema_migrations (version, name)
        values (${version}, ${file})
        on conflict (version) do nothing
      `;
      appliedVersions.add(version);
      recorded += 1;
      console.log(`  ${file} ... recorded`);
    }
    console.log(
      `\nDone. Baselined ${recorded} migration(s)${dryRun ? " (dry run)" : ""}.`,
    );
    process.exit(0);
  }

  // Normal mode: apply every file not yet in the ledger, in order.
  for (const file of files) {
    const version = versionOf(file);
    if (appliedVersions.has(version)) {
      skipped += 1;
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }
    if (dryRun) {
      console.log(`${file} ... WOULD apply`);
      applied += 1;
      continue;
    }
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`Applying ${file} ... `);
    try {
      // The migration file owns its own begin/commit. Once it commits, record
      // it in the ledger so a re-run skips it. If the ledger insert fails, the
      // migration has still committed; the error is surfaced so it can be
      // recorded manually (insert into schema_migrations).
      await sql.unsafe(body);
      await sql`
        insert into schema_migrations (version, name)
        values (${version}, ${file})
        on conflict (version) do nothing
      `;
      applied += 1;
      console.log("OK");
    } catch (err) {
      console.log("FAILED");
      console.error(`\n  ${file}: ${err.message}\n`);
      throw err;
    }
  }

  const summary = dryRun
    ? `\nDry run. Would apply ${applied} migration(s); ${skipped} already applied.`
    : `\nDone. Applied ${applied} migration(s); ${skipped} already applied.`;
  console.log(summary);
} catch {
  console.error(
    `\nStopped after applying ${applied} migration(s) this run. Fix the error ` +
      `above and re-run — already-applied migrations are recorded in ` +
      `schema_migrations and will be skipped.`,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
