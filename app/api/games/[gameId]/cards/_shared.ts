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
