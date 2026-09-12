/**
 * Diagnostic: where is the Supabase storage actually going?
 *
 * The dashboard's storage number is larger than `pg_database_size(current
 * database)` because it includes other databases, other schemas (auth, storage,
 * realtime, ...), and table bloat (dead tuples not yet vacuumed). This read-only
 * script breaks the usage down so we can see the real culprit before deciding
 * what to clean up. It changes NOTHING.
 *
 * USAGE:  node scripts/db-size-report.mjs
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("ERROR: SUPABASE_DB_URL is not set (checked .env.local).");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });

try {
  console.log("=== Size by schema (all schemas, this database) ===");
  const bySchema = await sql`
    select n.nspname as schema,
           pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size,
           sum(pg_total_relation_size(c.oid)) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'm', 't', 'i')
    group by n.nspname
    order by bytes desc
  `;
  for (const s of bySchema) {
    console.log(`  ${String(s.schema).padEnd(24)} ${s.size}`);
  }

  console.log("\n=== Top 15 relations across all schemas ===");
  const topRel = await sql`
    select n.nspname as schema,
           c.relname as name,
           pg_size_pretty(pg_total_relation_size(c.oid)) as size,
           pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
    order by bytes desc
    limit 15
  `;
  for (const r of topRel) {
    console.log(`  ${`${r.schema}.${r.name}`.padEnd(40)} ${r.size}`);
  }

  console.log("\n=== Dead tuples (bloat candidates for VACUUM) ===");
  const bloat = await sql`
    select schemaname as schema,
           relname as name,
           n_live_tup as live_rows,
           n_dead_tup as dead_rows,
           last_autovacuum
    from pg_stat_all_tables
    where n_dead_tup > 0
    order by n_dead_tup desc
    limit 15
  `;
  if (bloat.length === 0) {
    console.log("  (no dead tuples reported)");
  } else {
    for (const b of bloat) {
      console.log(
        `  ${`${b.schema}.${b.name}`.padEnd(40)} live=${b.live_rows} dead=${b.dead_rows}`,
      );
    }
  }

  console.log("\n=== Per-database sizes (cluster) ===");
  try {
    const dbs = await sql`
      select datname,
             pg_size_pretty(pg_database_size(datname)) as size,
             pg_database_size(datname) as bytes
      from pg_database
      order by bytes desc
    `;
    for (const d of dbs) {
      console.log(`  ${String(d.datname).padEnd(24)} ${d.size}`);
    }
  } catch (err) {
    console.log(`  (could not read pg_database: ${err.message})`);
  }
} catch (err) {
  console.error(`\nReport FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
