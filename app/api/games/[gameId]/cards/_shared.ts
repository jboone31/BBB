/**
 * Shared preamble for the per-team card mutation routes (keep / discard / play).
 *
 * Each card route authorizes the requester the same way: a valid session that is
 * a member of the game, the game is live, and the requester has a player row on a
 * team — that team is the one whose deck the operation mutates. This helper runs
 * that preamble inside the caller's transaction against the `FOR UPDATE`-locked
 * game row (via {@link assertMember}), so the authorization decision and the deck
 * transition that follows see the same serialized game state.
 *
 * It also maps the pure deck engine's rejection reasons (`DeckRejection`) onto
 * the structured route reasons in {@link LobbyErrorReason}, so a rejected
 * keep/discard/play surfaces as a precise 4xx instead of a 500.
 */
import type { QueryRunner } from "@/lib/events";
import type { DeckRejection } from "@/lib/cards/deck";
import {
  loadBehaviorState,
  settleDueTransitions,
  type BehaviorState,
} from "@/lib/cards/behaviorStore";

import { assertMember, type LobbyErrorReason } from "@/app/api/games/_shared";

const GAME_LIFECYCLE_SQL = `
select lifecycle
from games
where id = $1
`;

const PLAYER_FOR_SESSION_SQL = `
select team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

/** The resolved acting context for a card mutation: the requester's team. */
export type CardActorResult =
  | { readonly ok: true; readonly teamId: string }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

/**
 * Authorize a card mutation and resolve the acting team, inside the caller's
 * transaction. Returns the requester's team id on success, or a structured
 * reason (membership, lifecycle, or no-team) on rejection.
 */
export async function resolveCardActor(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<CardActorResult> {
  if (!(await assertMember(tx, gameId, sessionId))) {
    return { ok: false, reason: "not_member" };
  }

  const { rows: gameRows } = await tx.query(GAME_LIFECYCLE_SQL, [gameId]);
  if (gameRows.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (gameRows[0]?.lifecycle !== "live") {
    return { ok: false, reason: "not_live" };
  }

  const { rows: playerRows } = await tx.query(PLAYER_FOR_SESSION_SQL, [
    gameId,
    sessionId,
  ]);
  const teamId = playerRows[0]?.team_id;
  if (teamId == null) {
    return { ok: false, reason: "no_team" };
  }
  return { ok: true, teamId: String(teamId) };
}

const CLOCK_NOW_SQL = `select clock_timestamp() as now`;

/**
 * The resolved context every Card_Behavior_Mutation route needs after the
 * shared pipeline preamble: the acting team, the server `now`, and the single
 * loaded {@link BehaviorState} snapshot.
 */
export type CardMutationContext =
  | {
      readonly ok: true;
      readonly teamId: string;
      readonly nowIso: string;
      readonly state: BehaviorState;
    }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

/**
 * Run the Card_Behavior_Mutation pipeline preamble (design.md "Mutation
 * pipeline"), inside the caller's open transaction against the `FOR UPDATE`
 * locked game row:
 *
 *   1. authorize + resolve the acting team ({@link resolveCardActor});
 *   2. read `clock_timestamp()` as the server `now` (after the lock, so server
 *      time agrees with lock order);
 *   3. lazily settle due effect transitions ({@link settleDueTransitions},
 *      pipeline step 3) at that same `now`, before loading state, so the loaded
 *      snapshot reflects the flipped announcement flags and every boundary at or
 *      before `now` is announced with its transition events ordered before this
 *      mutation's own events;
 *   4. load the single {@link BehaviorState} snapshot ({@link loadBehaviorState})
 *      so the inventory follow-up planner sees the current challenge / offer
 *      state alongside the deck.
 *
 * Returns the acting team, the server `now`, and the loaded snapshot on success,
 * or a structured rejection reason (membership, lifecycle, or no-team) that the
 * caller maps to an HTTP response. The settle is a no-op for a non-live game,
 * which {@link resolveCardActor} rejects before we reach it anyway.
 */
export async function loadCardMutationContext(
  tx: QueryRunner,
  gameId: string,
  sessionId: string,
): Promise<CardMutationContext> {
  // Pipeline step 1: authorize + lock, resolving the acting team.
  const actor = await resolveCardActor(tx, gameId, sessionId);
  if (!actor.ok) {
    return { ok: false, reason: actor.reason };
  }

  // Pipeline step 2: server time, read after the lock.
  const { rows: clockRows } = await tx.query(CLOCK_NOW_SQL, []);
  const nowRaw = clockRows[0]?.now;
  const nowIso =
    nowRaw instanceof Date
      ? nowRaw.toISOString()
      : new Date(String(nowRaw)).toISOString();

  // Pipeline step 3: lazily settle due effect transitions at this `now`, under
  // the lock the caller already holds, before loading state.
  await settleDueTransitions(tx, gameId, nowIso);

  // Pipeline step 4: the single loaded snapshot, reflecting the settled flags.
  const state = await loadBehaviorState(tx, gameId, nowIso);

  return { ok: true, teamId: actor.teamId, nowIso, state };
}

/**
 * Map a pure deck-engine {@link DeckRejection} to the structured route reason the
 * client sees. Keeps the engine's vocabulary and the HTTP vocabulary in one
 * place so every card route reports rejections identically.
 */
export function deckRejectionReason(
  rejection: DeckRejection | string,
): LobbyErrorReason {
  switch (rejection) {
    case "pending_draw":
      // keep: there was no pending draw to resolve.
      return "no_pending_draw";
    case "card_not_pending":
      return "card_not_pending";
    case "card_not_in_hand":
      return "card_not_in_hand";
    case "hand_full":
      // keep: the hand is full, so the pending card cannot be kept until a held
      // card is played/discarded or the draw is forfeited (R2.4).
      return "hand_full";
    case "unknown_card":
      return "invalid_card";
    // Remaining draw-time rejections should not reach keep/discard/play, but map
    // them to a safe conflict reason rather than leaking an engine token.
    case "finish_bar":
    case "duplicate_bar_draw":
    case "deck_exhausted":
    default:
      return "invalid_card";
  }
}
