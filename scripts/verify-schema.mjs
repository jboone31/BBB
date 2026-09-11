/**
 * One-off post-migration verification: lists the public tables, enum types,
 * and the seeded card_definitions count. Read-only; prints no secrets.
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const sql = postgres(process.env.SUPABASE_DB_URL, { max: 1, prepare: false });
try {
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  console.log("Tables:", tables.map((r) => r.table_name).join(", "));

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
} catch (err) {
  console.error("Verification FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
