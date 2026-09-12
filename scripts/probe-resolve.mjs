/**
 * One-off probe: exercise the /api/games/resolve logic directly against the DB.
 *
 * Seeds a lobby game with a known join_code via the service role, then runs the
 * EXACT resolve query the route uses (join_code match, lifecycle <> 'ended')
 * against the direct connection to confirm the code resolves to the game id.
 * Also lists recent games so we can eyeball stored join_code casing/format.
 */
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", override: false });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;

const service = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = postgres(DB_URL, { prepare: false });

let gameId;
const code = `PROBE${Math.floor(Math.random() * 9000 + 1000)}`;
try {
  const { data: game, error: gErr } = await service
    .from("games")
    .insert({
      lifecycle: "lobby",
      admin_session_id: randomUUID(),
      join_code: code,
    })
    .select("id")
    .single();
  if (gErr) throw new Error(`seed game: ${gErr.message}`);
  gameId = game.id;
  console.log("seeded game:", gameId, "with join_code:", code);

  // The EXACT resolve query.
  const rows = await sql.unsafe(
    `select id from games where join_code = $1 and lifecycle <> 'ended' limit 1`,
    [code],
  );
  console.log("resolve exact-code rows:", JSON.stringify(rows));
  console.log(
    rows.length === 1 && rows[0].id === gameId
      ? "RESOLVE PASS: exact code resolves to the seeded game."
      : "RESOLVE FAIL for exact code.",
  );

  // Show the most recent few games' stored join_code + lifecycle to eyeball format.
  const recent = await sql.unsafe(
    `select id, join_code, lifecycle, created_at from games order by created_at desc limit 8`,
    [],
  );
  console.log("recent games:");
  for (const g of recent) {
    console.log(
      `  ${g.id}  code=${JSON.stringify(g.join_code)}  lifecycle=${g.lifecycle}`,
    );
  }
} catch (err) {
  console.error("PROBE ERROR:", err.message);
  process.exitCode = 1;
} finally {
  try {
    if (gameId) await service.from("games").delete().eq("id", gameId);
  } catch {}
  await sql.end({ timeout: 5 });
  console.log("cleaned up.");
}
