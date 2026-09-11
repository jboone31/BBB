/**
 * One-off probe: proves the Path-3 member session can read RLS-scoped rows.
 * Creates a throwaway auth user + game (admin=UID), seeds one game_events row
 * via service role, then reads it back through the MEMBER client (anon key +
 * bearer token). Expects to read exactly that row. Cleans everything up.
 *
 * Mirrors supabase/__tests__/integration/_session.ts but inline (JS) so it runs
 * without the TS test config.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

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
  const email = `it-${randomUUID()}@bbb-integration.test`;
  const password = `pw-${randomUUID()}`;
  const { data: created, error: cErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr) throw new Error(`createUser: ${cErr.message}`);
  userId = created.user.id;
  console.log("created auth user:", userId);

  const authClient = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: sErr } =
    await authClient.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`signIn: ${sErr.message}`);
  const token = signIn.session.access_token;
  console.log("signed in, got access token (len):", token.length);

  const { data: game, error: gErr } = await service
    .from("games")
    .insert({
      lifecycle: "lobby",
      admin_session_id: userId,
      join_code: `IT-${userId.slice(0, 8)}`,
    })
    .select("id")
    .single();
  if (gErr) throw new Error(`seed game: ${gErr.message}`);
  gameId = game.id;
  console.log("seeded game:", gameId);

  // Seed one event via service role.
  const { error: eErr } = await service.from("game_events").insert({
    game_id: gameId,
    seq: 1,
    event_type: "probe",
    actor_kind: "admin",
    payload: { probe: true },
  });
  if (eErr) throw new Error(`seed event: ${eErr.message}`);

  // Read back through the MEMBER client (RLS-scoped).
  const member = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: rows, error: rErr } = await member
    .from("game_events")
    .select("seq")
    .eq("game_id", gameId)
    .order("seq", { ascending: true });
  if (rErr) throw new Error(`member read: ${rErr.message}`);

  const seqs = (rows ?? []).map((r) => r.seq);
  console.log("member client read seqs:", JSON.stringify(seqs));
  if (seqs.length === 1 && Number(seqs[0]) === 1) {
    console.log(
      "PROBE PASS: member client can read its game's events under RLS.",
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
