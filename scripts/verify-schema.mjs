/**
 * One-off post-migration verification: lists the public tables, enum types,
 * and the seeded card_definitions count, then checks that the specific schema
 * objects introduced by each migration are present. Read-only; prints no
 * secrets.
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const sql = postgres(process.env.SUPABASE_DB_URL, { max: 1, prepare: false });

/**
 * Expected schema objects, grouped by the migration that introduces them. Each
 * entry names a concrete object (table, column, constraint, or index) checked
 * against the live catalog below. Keep this list in sync with the migrations in
 * supabase/migrations.
 */
const EXPECTED = {
  // 0013_card_behavior
  tables: [
    "card_challenges",
    "card_effects",
    "fairest_offers",
    "card_effect_awards",
  ],
  columns: [
    // card_plays: the enriched play record
    ["card_plays", "slug"],
    ["card_plays", "target_bar_id"],
    ["card_plays", "target_bar_key"],
    ["card_plays", "params"],
    // team_decks: Power Hour keep-all pending mode
    ["team_decks", "pending_mode"],
    // score_ledger_entries: link to source effect
    ["score_ledger_entries", "source_effect_id"],
  ],
  constraints: [
    // claims: card-driven revocation reason
    ["claims", "claims_revoked_reason_valid"],
    // card_plays constraints
    ["card_plays", "card_plays_target_bar_fk"],
    ["card_plays", "card_plays_params_object"],
    ["card_plays", "card_plays_id_game_unique"],
    // card_challenges
    ["card_challenges", "card_challenges_play_fk"],
    ["card_challenges", "card_challenges_caster_fk"],
    ["card_challenges", "card_challenges_target_fk"],
    ["card_challenges", "card_challenges_distinct_teams"],
    ["card_challenges", "card_challenges_resolution_fields"],
    ["card_challenges", "card_challenges_id_game_unique"],
    // card_effects
    ["card_effects", "card_effects_window_valid"],
    ["card_effects", "card_effects_cancel_fields"],
    ["card_effects", "card_effects_owner_fk"],
    ["card_effects", "card_effects_target_team_fk"],
    ["card_effects", "card_effects_target_bar_fk"],
    ["card_effects", "card_effects_attached_claim_fk"],
    ["card_effects", "card_effects_id_game_unique"],
    // fairest_offers
    ["fairest_offers", "fairest_offers_once"],
    ["fairest_offers", "fairest_offers_subject"],
    // card_effect_awards
    ["card_effect_awards", "card_effect_awards_effect_fk"],
    // score_ledger_entries: composite FK to the source effect
    ["score_ledger_entries", "score_ledger_entries_effect_fk"],
  ],
  indexes: [
    "card_challenges_open_target_idx",
    "card_effects_live_idx",
    "card_effects_due_idx",
    "card_effect_awards_one_live",
    "game_events_effect_transition_once",
  ],
};

let missing = 0;

function report(label, expected, present) {
  const have = new Set(present);
  const gaps = expected.filter((name) => !have.has(name));
  if (gaps.length === 0) {
    console.log(`${label}: OK (${expected.length})`);
  } else {
    missing += gaps.length;
    console.error(`${label}: MISSING ${gaps.join(", ")}`);
  }
}

try {
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  const tableNames = tables.map((r) => r.table_name);
  console.log("Tables:", tableNames.join(", "));

  const enums = await sql`
    select t.typname from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e' order by t.typname`;
  console.log("Enums:", enums.map((r) => r.typname).join(", "));

  const cards = await sql`select count(*)::int as n from card_definitions`;
  console.log("card_definitions rows:", cards[0].n);

  const rls = await sql`
    select count(*)::int as n from pg_policies where schemaname = 'public'`;
  console.log("RLS policies:", rls[0].n);

  // --- 0013_card_behavior expectations ---------------------------------------

  // New tables.
  report("Expected tables", EXPECTED.tables, tableNames);

  // New columns, matched on table_name + column_name.
  const columns = await sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'`;
  const presentColumns = columns.map((r) => `${r.table_name}.${r.column_name}`);
  report(
    "Expected columns",
    EXPECTED.columns.map(([t, c]) => `${t}.${c}`),
    presentColumns,
  );

  // Table constraints (check, foreign key, unique, primary key), matched on
  // table_name + constraint_name so same-named constraints on different tables
  // are distinguished.
  const constraints = await sql`
    select table_name, constraint_name from information_schema.table_constraints
    where table_schema = 'public'`;
  const presentConstraints = constraints.map(
    (r) => `${r.table_name}.${r.constraint_name}`,
  );
  report(
    "Expected constraints",
    EXPECTED.constraints.map(([t, c]) => `${t}.${c}`),
    presentConstraints,
  );

  // Indexes (includes the unique indexes that back constraints as well as the
  // standalone partial indexes).
  const indexes = await sql`
    select indexname from pg_indexes where schemaname = 'public'`;
  report(
    "Expected indexes",
    EXPECTED.indexes,
    indexes.map((r) => r.indexname),
  );

  if (missing > 0) {
    console.error(`Verification FAILED: ${missing} expected object(s) missing`);
    process.exitCode = 1;
  } else {
    console.log("Schema verification OK");
  }
} catch (err) {
  console.error("Verification FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
