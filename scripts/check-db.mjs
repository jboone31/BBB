/**
 * One-off connectivity check for SUPABASE_DB_URL (loaded from .env.local).
 * Connects, runs `select 1`, and prints the host it reached — never the
 * password. Used to confirm the pooler host resolves before applying migrations.
 */
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

loadDotenv({ path: ".env.local", override: false });

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL not set");
  process.exit(1);
}

// Print the host:port only (no credentials).
let hostLabel = "(unparseable)";
try {
  const u = new URL(dbUrl);
  hostLabel = `${u.hostname}:${u.port || "(default)"} user=${u.username}`;
} catch {
  /* ignore */
}
console.log(`Connecting to ${hostLabel} ...`);

const sql = postgres(dbUrl, { max: 1, prepare: false });
try {
  const rows = await sql`select 1 as ok`;
  console.log(`Connected. select 1 -> ${rows[0].ok}`);
} catch (err) {
  console.error(`Connection FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
