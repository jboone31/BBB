/**
 * Lobby-phase and authorization gates for the Game Setup & Lobby feature
 * (design §Components 1d/1e, Correctness Properties 9, 11, 12, 13).
 *
 * These are the small, pure predicates every lobby mutation consults before it
 * touches state: is the Game still in its lobby phase, is the requester the
 * Admin, is the requester a member of the Game, and are both route bars
 * designated (the precondition for starting). Keeping them pure and I/O-free
 * lets the route handlers call them inside a transaction against the locked game
 * row and lets them be property-tested in isolation.
 *
 * This module is framework-free and performs no I/O. It reuses `GameLifecycle`
 * from `lib/gameend` rather than redefining the lifecycle union.
 *
 * Covers: Requirements 2.6, 2.8, 3.4, 4.8, 5.5, 5.6, 5.7, 8.4, 8.5, 8.8.
 */

import type { GameLifecycle } from "@/lib/gameend";

/**
 * Lobby-phase gate (R2.6, R3.4, R4.8, R5.7; Property 11).
 *
 * True iff the Game's lifecycle is `lobby`. Every lobby mutation (designate
 * bars, join, create/switch team, start) is permitted only while the Game is in
 * its lobby phase; for `live` or `ended` the mutation is rejected and the
 * targeted state is left unchanged.
 *
 * @param lifecycle the Game's current lifecycle.
 * @returns `true` iff `lifecycle === "lobby"`.
 */
export function isLobbyPhase(lifecycle: GameLifecycle): boolean {
  return lifecycle === "lobby";
}

/**
 * Admin-authorization gate (R2.8, R5.6, R8.1, R8.8; Property 12).
 *
 * True iff the requesting Session equals the Game's `admin_session_id` by exact
 * match. Admin-only actions (designate bars, start game, and admin capabilities
 * generally) are permitted only for the Admin session; any other session is
 * rejected and the targeted state is left unchanged.
 *
 * A `null`, `undefined`, or empty requester (no valid session) is never the
 * Admin, and a `null`/`undefined`/empty `adminSessionId` never matches, so a
 * request with a missing session can never be mistaken for the Admin.
 *
 * @param adminSessionId the Game's recorded `admin_session_id`.
 * @param requesterSessionId the session presented on the request.
 * @returns `true` iff both are non-empty and exactly equal.
 */
export function isAdmin(
  adminSessionId: string | null | undefined,
  requesterSessionId: string | null | undefined,
): boolean {
  if (!adminSessionId || !requesterSessionId) {
    return false;
  }
  return adminSessionId === requesterSessionId;
}

/**
 * Membership-authorization gate (R8.4, R8.5; Property 13).
 *
 * True iff the requesting Session is a member of the Game — i.e. its session
 * identifier appears in the Game's membership set (the Admin session plus every
 * joined Player's session). A request to modify a Game's lobby state is
 * permitted only for a member; a non-member request is rejected and leaves the
 * state unchanged.
 *
 * A `null`, `undefined`, or empty requester (no valid session) is never a
 * member, regardless of the membership set.
 *
 * @param memberSessionIds the session identifiers that belong to the Game.
 * @param requesterSessionId the session presented on the request.
 * @returns `true` iff `requesterSessionId` is non-empty and present in
 *   `memberSessionIds`.
 */
export function isMember(
  memberSessionIds: readonly string[],
  requesterSessionId: string | null | undefined,
): boolean {
  if (!requesterSessionId) {
    return false;
  }
  return memberSessionIds.includes(requesterSessionId);
}

/**
 * Start-bar-designation gate (R5.5; Property 9).
 *
 * True iff both the Start_Bar and the Finish_Bar are designated (non-null). A
 * Game may only start once it has a defined route from beginning to end; if
 * either bar is missing, the start request is rejected and the Game is left in
 * the lobby.
 *
 * This gate is only concerned with *presence*; the start-bar ≠ finish-bar rule
 * is owned by `validateBarDesignation` in `lib/games` (Property 10), enforced
 * when the designation is recorded.
 *
 * @param startBarId the Game's `start_bar_id`, or `null` when undesignated.
 * @param finishBarId the Game's `finish_bar_id`, or `null` when undesignated.
 * @returns `true` iff both bars are designated.
 */
export function bothBarsDesignated(
  startBarId: string | null | undefined,
  finishBarId: string | null | undefined,
): boolean {
  return startBarId != null && finishBarId != null;
}
