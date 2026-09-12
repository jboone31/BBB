/**
 * One-off VACUUM to reclaim table bloat (dead tuples) and refresh planner stats.
 *
 * A regular VACUUM returns dead-tuple space to Postgres for reuse and, with
 * ANALYZE, updates statistics; it does NOT lock tables for writes the way
 * VACUUM FULL does. This is the safe, routine reclaim — appropriate for the
 * small catalog/auth bloat observed in db-size-report.mjs. It changes no rows.
 *
 * USAGE:  node scripts/vacuum-now.mjs
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("ERROR: SUPABASE_DB_URL is not set (checked .env.local).");
  process.exit(1);
}

// VACUUM cannot run inside a transaction block, so keep a single simple session.
const sql = postgres(dbUrl, { max: 1, prepare: false });

try {
  const before = await sql`
    select pg_size_pretty(pg_database_size(current_database())) as size
  `;
  console.log(`DB size BEFORE: ${before[0].size}`);

  console.log("Running VACUUM (ANALYZE) across the database ...");
  await sql.unsafe("vacuum (analyze)");
  console.log("VACUUM complete.");

  const after = await sql`
    select pg_size_pretty(pg_database_size(current_database())) as size
  `;
  console.log(`DB size AFTER:  ${after[0].size}`);
} catch (err) {
  console.error(`\nVACUUM FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 15 });
}
