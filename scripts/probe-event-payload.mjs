/**
 * One-off probe: dump the raw shape of a game's game_events payloads as the
 * browser client receives them, to diagnose why foldLobbyEvents produces a null
 * joinCode despite reading the events.
 *
 * Signs in anonymously, seeds a game (admin=UID) + a game_created event with a
 * joinCode payload via the service role, then reads the events back through the
 * anonymous member client (the app's exact read path) and prints, per row, the
 * typeof payload and its value. This tells us whether `payload` arrives as a
 * parsed object (fold works) or a JSON string (fold's readString fails).
 */
import { createClient } from "@supabase/supabase-js";

import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", override: false });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const service = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let userId, gameId;
try {
  const appClient = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: anon, error: aErr } = await appClient.auth.signInAnonymously();
  if (aErr) throw new Error(`signInAnonymously: ${aErr.message}`);
  userId = anon.session.user.id;

  const { data: game, error: gErr } = await service
    .from("games")
    .insert({
      lifecycle: "lobby",
      admin_session_id: userId,
      join_code: "PROBE123",
    })
    .select("id")
    .single();
  if (gErr) throw new Error(`seed game: ${gErr.message}`);
  gameId = game.id;

  const { error: eErr } = await service.from("game_events").insert({
    game_id: gameId,
    seq: 1,
    event_type: "game_created",
    actor_kind: "admin",
    payload: { joinCode: "PROBE123" },
  });
  if (eErr) throw new Error(`seed event: ${eErr.message}`);

  // Read back through the anonymous member client (the app's read path).
  const { data: rows, error: rErr } = await appClient
    .from("game_events")
    .select(
      "id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at",
    )
    .eq("game_id", gameId)
    .order("seq", { ascending: true });
  if (rErr) throw new Error(`read: ${rErr.message}`);

  for (const row of rows ?? []) {
    console.log("--- row seq", row.seq, "type", row.event_type);
    console.log("    typeof payload:", typeof row.payload);
    console.log("    payload value :", JSON.stringify(row.payload));
    console.log(
      "    payload.joinCode:",
      row.payload && typeof row.payload === "object"
        ? row.payload.joinCode
        : "(not an object)",
    );
  }
} catch (err) {
  console.error("PROBE ERROR:", err.message);
  process.exitCode = 1;
} finally {
  try {
    if (gameId) await service.from("games").delete().eq("id", gameId);
  } catch {}
  try {
    if (userId) await service.auth.admin.deleteUser(userId);
  } catch {}
  console.log("cleaned up.");
}
