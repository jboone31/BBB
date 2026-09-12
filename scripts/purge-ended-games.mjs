/**
 * Purge old, ended games to keep the Supabase database under the free-tier
 * storage limit.
 *
 * WHY THIS WORKS WITH JUST `games`:
 * The entire data model is game-scoped and cascades from the `games` table.
 * `bars`, `teams`, `players`, `claims`, `card_instances`, `card_plays`, and the
 * append-only `game_events` log all have `on delete cascade` to `games` (see
 * supabase/migrations/0001..0004). So deleting an ended game row removes every
 * related row across all those tables in one statement. The only static data is
 * `card_definitions` (the game-independent seeded catalog), which this script
 * NEVER touches.
 *
 * WHAT IT KEEPS:
 *   - card_definitions (the seeded card catalog — static, shared by all games)
 *   - games that are NOT ended (lifecycle in 'lobby' | 'live')
 *   - ended games newer than the retention window (default 7 days)
 *
 * WHAT IT REMOVES:
 *   - every game with lifecycle = 'ended' whose most recent event (or created_at
 *     if it somehow has no events) is older than the retention window, plus all
 *     of that game's cascaded rows.
 *
 * DISK RECLAMATION:
 * A plain DELETE leaves dead tuples behind, so the storage number Supabase
 * reports does NOT shrink until those pages are reclaimed. This script runs
 * `VACUUM` after the delete so space is actually returned. (VACUUM cannot run
 * inside a transaction block, so it runs on its own after the delete commits.)
 *
 * SAFETY:
 *   - Never deletes lobby/live games.
 *   - Defaults to a DRY RUN: it reports what it WOULD delete and current table
 *     sizes, and changes nothing. Pass --apply to actually delete.
 *   - Retention window is configurable via --days=N (default 7).
 *
 * USAGE:
 *   node scripts/purge-ended-games.mjs                 # dry run, 7-day retention
 *   node scripts/purge-ended-games.mjs --days=14       # dry run, 14-day retention
 *   node scripts/purge-ended-games.mjs --apply         # delete + vacuum, 7-day retention
 *   node scripts/purge-ended-games.mjs --apply --days=3
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const daysArg = args.find((a) => a.startsWith("--days="));
const RETENTION_DAYS = daysArg ? Number(daysArg.split("=")[1]) : 7;

if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 0) {
  console.error(`ERROR: --days must be a non-negative number (got "${daysArg}").`);
  process.exit(1);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl || dbUrl.trim().length === 0) {
  console.error("ERROR: SUPABASE_DB_URL is not set (checked .env.local).");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });

/** Print per-table size + total DB size so you can see what's using space. */
async function reportSizes(label) {
  const total = await sql`select pg_size_pretty(pg_database_size(current_database())) as size`;
  const tables = await sql`
    select
      relname as table,
      pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
      pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc
  `;
  console.log(`\n=== ${label} ===`);
  console.log(`Total database size: ${total[0].size}`);
  for (const t of tables) {
    console.log(`  ${t.table.padEnd(20)} ${t.total_size}`);
  }
}

try {
  console.log(
    `Mode: ${APPLY ? "APPLY (will delete + vacuum)" : "DRY RUN (no changes)"} | retention: ${RETENTION_DAYS} day(s)`,
  );

  await reportSizes("BEFORE");

  // Ended games whose latest activity is older than the retention window.
  // "latest activity" = max(game_events.created_at) for the game, falling back
  // to games.created_at when a game somehow has no events.
  const cutoffSelect = sql`
    select g.id,
           g.created_at,
           (select max(ge.created_at) from game_events ge where ge.game_id = g.id) as last_event_at
    from games g
    where g.lifecycle = 'ended'
      and coalesce(
            (select max(ge.created_at) from game_events ge where ge.game_id = g.id),
            g.created_at
          ) < now() - (${RETENTION_DAYS} * interval '1 day')
    order by g.created_at asc
  `;
  const candidates = await cutoffSelect;

  console.log(
    `\nEnded games older than ${RETENTION_DAYS} day(s): ${candidates.length}`,
  );
  for (const g of candidates) {
    const when = g.last_event_at ?? g.created_at;
    console.log(`  ${g.id}  last activity: ${new Date(when).toISOString()}`);
  }

  if (candidates.length === 0) {
    console.log("\nNothing to purge.");
  } else if (!APPLY) {
    console.log(
      `\nDRY RUN: would delete the ${candidates.length} game(s) above (and all their ` +
        `cascaded bars/teams/players/claims/cards/events). Re-run with --apply to do it.`,
    );
  } else {
    // Single DELETE; cascades wipe every related row across all tables.
    const ids = candidates.map((g) => g.id);
    const deleted = await sql`
      delete from games
      where id in ${sql(ids)}
      returning id
    `;
    console.log(`\nDeleted ${deleted.length} game(s) (cascaded to all related rows).`);

    // Reclaim disk so the reported storage actually drops. VACUUM can't run in a
    // transaction; postgres.js sends this as its own simple query.
    console.log("Running VACUUM to reclaim space (this may take a moment) ...");
    await sql.unsafe("vacuum");
    console.log("VACUUM complete.");

    await reportSizes("AFTER");
  }
} catch (err) {
  console.error(`\nPurge FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
