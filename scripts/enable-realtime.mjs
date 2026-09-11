/**
 * Enable Supabase Realtime for `public.game_events` by ensuring it is a member
 * of the `supabase_realtime` publication (what `postgres_changes` subscriptions
 * read from). Idempotent: checks membership first and only adds if missing.
 * Read-mostly; the only write is `alter publication ... add table` when needed.
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const sql = postgres(process.env.SUPABASE_DB_URL, { max: 1, prepare: false });
try {
  // Does the supabase_realtime publication exist? (It ships with Supabase.)
  const pub = await sql`
    select 1 from pg_publication where pubname = 'supabase_realtime'`;
  if (pub.length === 0) {
    console.log(
      "Publication 'supabase_realtime' does not exist; creating it for game_events.",
    );
    await sql`create publication supabase_realtime for table game_events`;
    console.log("Created publication and added game_events.");
  } else {
    const already = await sql`
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'game_events'`;
    if (already.length > 0) {
      console.log(
        "game_events is ALREADY in supabase_realtime. Nothing to do.",
      );
    } else {
      await sql`alter publication supabase_realtime add table game_events`;
      console.log("Added public.game_events to supabase_realtime.");
    }
  }

  // Report the final publication membership for confirmation.
  const members = await sql`
    select schemaname, tablename from pg_publication_tables
    where pubname = 'supabase_realtime' order by schemaname, tablename`;
  console.log(
    "supabase_realtime tables:",
    members.map((r) => `${r.schemaname}.${r.tablename}`).join(", ") || "(none)",
  );
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
