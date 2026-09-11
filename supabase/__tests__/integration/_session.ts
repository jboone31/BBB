/**
 * Shared integration-test session helper (Option A / Path 3).
 *
 * The live integration suites must read/subscribe to `game_events` through the
 * ANON client, which is subject to RLS. The `0006` policies only permit a read
 * when `bbb_is_game_member(game_id)` is true — i.e. the request's JWT `sub`
 * claim matches a `players.session_id` or the game's `admin_session_id`. A plain
 * anon client has no session, so every read is (correctly) denied and returns
 * `[]`.
 *
 * Rather than mint a JWT by hand (the legacy HS256 "JWT secret" is deprecated and
 * the project may be on asymmetric signing keys), this helper uses **real
 * Supabase Auth** so the token is minted by Supabase under whatever signing
 * scheme the project uses:
 *
 *   1. Create a throwaway, email-confirmed user via the service-role admin API
 *      (`auth.admin.createUser`). The user's id (UID) becomes the session id.
 *   2. Sign that user in with the anon key to obtain a genuine access token.
 *   3. Build a member-authenticated Supabase client that carries the access
 *      token on BOTH the PostgREST requests (via `global.headers`) and the
 *      Realtime socket (via `realtime.setAuth` after connect), so snapshot reads
 *      and `postgres_changes` subscriptions run as that authenticated member.
 *   4. Seed a game whose `admin_session_id` equals the user's UID (and,
 *      optionally, a team + player row for that UID), so `bbb_is_game_member()`
 *      returns true for the game.
 *
 * Everything is created with the service-role key (bypasses RLS) for setup and
 * torn down in `cleanup()`; the member client is used only for the RLS-scoped
 * reads/subscriptions under test.
 *
 * Requires (from .env.local, already loaded by vitest.setup.integration.ts):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   - SUPABASE_SERVICE_ROLE_KEY
 * (No JWT secret / signing key needed — the token is minted by Supabase Auth.)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** A service-role client: bypasses RLS, used for all fixture setup/teardown. */
export function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A member-authenticated Supabase client plus the identity + game it is scoped
 * to, and a cleanup that removes everything it created.
 */
export interface MemberSession {
  /**
   * A Supabase client authenticated as the throwaway member (access token on
   * both PostgREST and Realtime). Use this for the RLS-scoped reads /
   * subscriptions under test.
   */
  readonly memberClient: SupabaseClient;
  /** The service-role client (RLS-bypassing) for seeding/teardown. */
  readonly service: SupabaseClient;
  /** The authenticated user's id — also the game's admin_session_id. */
  readonly sessionId: string;
  /** The member's Supabase access token (bearer), for building extra clients. */
  readonly accessToken: string;
  /**
   * Build an ADDITIONAL member-authenticated client carrying the same access
   * token. Each Supabase client keys realtime channels by name, so two
   * subscriptions to the same game must use two DISTINCT clients — call this to
   * get a second one rather than reusing {@link memberClient}.
   */
  makeMemberClient(): SupabaseClient;
  /** The seeded game's id (member is its admin). */
  readonly gameId: string;
  /** Remove the seeded game (cascade) and delete the throwaway auth user. */
  cleanup(): Promise<void>;
}

/** Options for {@link createMemberSession}. */
export interface CreateMemberSessionOptions {
  /**
   * Also create a `teams` row and a `players` row for the member in the game, so
   * membership holds via a player (not just the admin). Returns the team id via
   * the resolved session's `teamId` when true. Defaults to false (admin-only
   * membership, which is enough for `bbb_is_game_member`).
   */
  readonly withPlayer?: boolean;
}

/**
 * Create a throwaway auth user, sign it in, and seed a game it administers so it
 * is a member under RLS. Returns a member-authenticated client for the suites.
 */
export async function createMemberSession(
  options: CreateMemberSessionOptions = {},
): Promise<MemberSession> {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "createMemberSession requires NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  const service = createServiceClient();

  // 1. Create a throwaway, email-confirmed user via the admin API.
  const email = `it-${randomUUID()}@bbb-integration.test`;
  const password = `pw-${randomUUID()}`;
  const { data: created, error: createErr } =
    await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createErr !== null || !created?.user) {
    throw new Error(
      `failed to create test auth user: ${createErr?.message ?? "no user"}`,
    );
  }
  const sessionId = created.user.id;

  // 2. Sign the user in with the anon key to obtain a real access token.
  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: signInErr } =
    await authClient.auth.signInWithPassword({ email, password });
  if (signInErr !== null || !signIn?.session) {
    throw new Error(
      `failed to sign in test user: ${signInErr?.message ?? "no session"}`,
    );
  }
  const accessToken = signIn.session.access_token;

  // 3. Build a member-authenticated client. The Authorization header scopes
  //    PostgREST reads; realtime.setAuth scopes the realtime socket so
  //    postgres_changes are evaluated as this authenticated member.
  //
  //    Each Supabase client keys realtime channels by name, so two subscriptions
  //    to the same game need two DISTINCT clients. `makeMemberClient` builds an
  //    additional client carrying the same token for that case.
  const makeMemberClient = (): SupabaseClient => {
    const c = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    c.realtime.setAuth(accessToken);
    return c;
  };
  const memberClient = makeMemberClient();

  // 4. Seed a game administered by this user (admin_session_id = UID), so
  //    bbb_is_game_member(gameId) is true for this session.
  const { data: game, error: gameErr } = await service
    .from("games")
    .insert({
      lifecycle: "lobby",
      admin_session_id: sessionId,
      join_code: `IT-${sessionId.slice(0, 8)}`,
    })
    .select("id")
    .single();
  if (gameErr !== null || !game) {
    throw new Error(`failed to seed game: ${gameErr?.message ?? "no row"}`);
  }
  const gameId = String((game as { id: string }).id);

  // Optionally also add a team + player for the member.
  if (options.withPlayer === true) {
    const { data: team, error: teamErr } = await service
      .from("teams")
      .insert({ game_id: gameId, name: "IT Team", color: "#3366ff" })
      .select("id")
      .single();
    if (teamErr !== null || !team) {
      throw new Error(`failed to seed team: ${teamErr?.message ?? "no row"}`);
    }
    const teamId = String((team as { id: string }).id);
    const { error: playerErr } = await service.from("players").insert({
      team_id: teamId,
      game_id: gameId,
      session_id: sessionId,
      display_name: "IT Player",
    });
    if (playerErr !== null) {
      throw new Error(`failed to seed player: ${playerErr.message}`);
    }
  }

  const cleanup = async (): Promise<void> => {
    // Cascade-delete the game (removes teams/players/events), then the user.
    try {
      await service.from("games").delete().eq("id", gameId);
    } catch {
      /* best-effort */
    }
    try {
      await service.auth.admin.deleteUser(sessionId);
    } catch {
      /* best-effort */
    }
  };

  return {
    memberClient,
    service,
    sessionId,
    accessToken,
    makeMemberClient,
    gameId,
    cleanup,
  };
}
