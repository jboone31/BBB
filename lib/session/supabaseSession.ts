/**
 * Browser Supabase-auth session bridge (identity for RLS-scoped reads/realtime).
 *
 * BBB is session-based, not account-based: an Admin is the session that created
 * a game, a Player is a session that joined one. The session identifier is sent
 * as `x-bbb-session-id` on every server-route request and written by those
 * routes to `games.admin_session_id` / `players.session_id`.
 *
 * The `0006_rls_policies` migration scopes every game-scoped table read to the
 * current session's membership, resolving "the current session id" from the
 * Supabase Auth JWT `sub` claim (`request.jwt.claims -> sub`). A bare anon
 * Supabase client carries no JWT `sub`, so `bbb_current_session_id()` is NULL,
 * membership fails closed, and the browser reads ZERO `game_events` rows — the
 * snapshot fold comes back empty and nothing (join code, bars, roster) surfaces.
 *
 * This module bridges the two identity systems using **Supabase Anonymous Auth**:
 * the browser signs in anonymously and receives a real JWT whose `sub` is a
 * Supabase user id (UID). We adopt that UID as THE BBB session id, so:
 *
 *   - it is sent as `x-bbb-session-id` to our server routes (which persist it to
 *     `admin_session_id` / `session_id`), AND
 *   - it is the JWT `sub` RLS matches — so `bbb_is_game_member()` returns true
 *     and RLS-scoped reads + realtime `postgres_changes` work as designed.
 *
 * The anonymous session is persisted and auto-refreshed by `@supabase/supabase-js`
 * (see `supabaseBrowser.ts`), so the same identity survives reload — matching the
 * durability the old localStorage `SessionStore` provided.
 *
 * Activation prerequisite: "Anonymous sign-ins" must be enabled in the Supabase
 * project (Authentication settings). When it is not, `signInAnonymously()`
 * returns an error and {@link establishBrowserSession} rejects.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The established browser session: the BBB session id (the Supabase Auth UID)
 * and the access token that authorizes RLS-scoped reads and realtime.
 */
export interface BrowserSession {
  /** The Supabase Auth UID, adopted as the BBB session id (JWT `sub` == this). */
  readonly sessionId: string;
  /** The current access token (bearer) authorizing PostgREST + realtime. */
  readonly accessToken: string;
}

/**
 * Ensure the browser holds a Supabase Auth session, signing in anonymously when
 * none exists, and return the resulting BBB session identity.
 *
 * Idempotent: if a persisted anonymous session is already present (a prior
 * launch on the same device+browser), it is reused rather than creating a new
 * identity — so the session id is stable across reloads. Only when there is no
 * session does it call `signInAnonymously()`.
 *
 * After this resolves, the client's persisted auth session authorizes PostgREST
 * reads automatically; the caller must still push the token onto the realtime
 * socket via {@link bindRealtimeAuth} (which also keeps it fresh on refresh).
 *
 * @param client the browser Supabase client (persistSession + autoRefreshToken).
 * @returns the BBB session id (Supabase UID) and access token.
 * @throws if anonymous sign-in fails (e.g. anonymous sign-ins not enabled).
 */
export async function establishBrowserSession(
  client: SupabaseClient,
): Promise<BrowserSession> {
  // Reuse a persisted session when present (stable identity across reloads).
  const existing = await client.auth.getSession();
  const existingSession = existing.data.session;
  if (
    existingSession !== null &&
    typeof existingSession.user.id === "string" &&
    existingSession.user.id.length > 0
  ) {
    return {
      sessionId: existingSession.user.id,
      accessToken: existingSession.access_token,
    };
  }

  // No session yet: sign in anonymously to mint a real JWT whose `sub` is the
  // UID we adopt as the BBB session id.
  const { data, error } = await client.auth.signInAnonymously();
  if (error !== null) {
    throw new Error(`anonymous sign-in failed: ${error.message}`);
  }
  const session = data.session;
  if (
    session === null ||
    typeof session.user.id !== "string" ||
    session.user.id.length === 0
  ) {
    throw new Error("anonymous sign-in returned no session");
  }
  return { sessionId: session.user.id, accessToken: session.access_token };
}

/**
 * Push the current access token onto the realtime socket and keep it fresh.
 *
 * PostgREST reads are authorized by the client's persisted auth session
 * automatically, but the realtime socket must be told the token explicitly via
 * `realtime.setAuth(token)` for `postgres_changes` to be evaluated as the
 * authenticated member (this is exactly what the integration tests do). Because
 * the anonymous token auto-refreshes, we re-apply it on every auth state change
 * (`TOKEN_REFRESHED`, `SIGNED_IN`) so a mid-session refresh does not silently
 * drop realtime authorization.
 *
 * @param client the browser Supabase client.
 * @param initialToken the token from {@link establishBrowserSession} to apply now.
 * @returns an unsubscribe function that stops listening for auth changes.
 */
export function bindRealtimeAuth(
  client: SupabaseClient,
  initialToken: string,
): () => void {
  // Apply the current token to the realtime socket immediately.
  client.realtime.setAuth(initialToken);

  // Re-apply on refresh/sign-in so realtime never runs with a stale token.
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    if (session !== null && typeof session.access_token === "string") {
      client.realtime.setAuth(session.access_token);
    }
  });

  return () => {
    data.subscription.unsubscribe();
  };
}
