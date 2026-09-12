/**
 * One-off probe: proves an ANONYMOUS-AUTH session (the exact path the browser
 * app now uses) can read its game's RLS-scoped rows — and, critically, does so
 * WITHOUT explicit `global.headers`, relying only on the client's own auth
 * session the way the app does (persistSession + signInAnonymously on the same
 * client instance).
 *
 * It signs in anonymously, takes the UID as the BBB session id, seeds a game
 * whose admin_session_id = that UID + one game_events row via the service role,
 * then reads the events back through the SAME anon client that holds the auth
 * session (no Authorization header injected). Expects to read exactly that row.
 *
 * This isolates whether the APP'S read path (auth session, not injected header)
 * is actually authorized — the thing our mocked unit tests cannot catch.
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
  // 1. Anonymous sign-in on a client we will ALSO use to read (the app's model:
  //    one client instance holds the auth session and issues the reads).
  const appClient = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: anon, error: aErr } = await appClient.auth.signInAnonymously();
  if (aErr) throw new Error(`signInAnonymously: ${aErr.message}`);
  if (!anon.session) throw new Error("no session from signInAnonymously");
  userId = anon.session.user.id;
  console.log("anonymous user UID:", userId);
  console.log("is_anonymous claim:", anon.session.user.is_anonymous);

  // Confirm the client reports the session it will use for reads.
  const { data: got } = await appClient.auth.getSession();
  console.log("appClient has session:", got.session !== null);

  // 2. Seed a game administered by that UID + one event (service role).
  const { data: game, error: gErr } = await service
    .from("games")
    .insert({
      lifecycle: "lobby",
      admin_session_id: userId,
      join_code: `AN-${userId.slice(0, 8)}`,
    })
    .select("id")
    .single();
  if (gErr) throw new Error(`seed game: ${gErr.message}`);
  gameId = game.id;
  console.log("seeded game:", gameId);

  const { error: eErr } = await service.from("game_events").insert({
    game_id: gameId,
    seq: 1,
    event_type: "probe",
    actor_kind: "admin",
    payload: { probe: true },
  });
  if (eErr) throw new Error(`seed event: ${eErr.message}`);

  // 3. Read back through the SAME app client (auth session only, NO injected
  //    Authorization header) — exactly what supabaseSnapshotSource does.
  const { data: rows, error: rErr } = await appClient
    .from("game_events")
    .select("seq")
    .eq("game_id", gameId)
    .order("seq", { ascending: true });
  if (rErr) throw new Error(`app read: ${rErr.message}`);

  const seqs = (rows ?? []).map((r) => r.seq);
  console.log("app-client (auth-session) read seqs:", JSON.stringify(seqs));
  if (seqs.length === 1 && Number(seqs[0]) === 1) {
    console.log(
      "PROBE PASS: app client (auth session, no injected header) reads its events.",
    );
  } else {
    console.log("PROBE FAIL: expected [1], got", JSON.stringify(seqs));
    process.exitCode = 1;
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
