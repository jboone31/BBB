/**
 * Discard-card route (brawl-deck-architecture Task 5), reworked onto the
 * Card_Behavior_Mutation pipeline (card-behavior Task 7.3).
 *
 * POST /api/games/{gameId}/cards/discard — the requesting team discards one card
 * it holds. The engine's `discardCard` accepts either a card in hand (freeing a
 * hand slot — R2.4) or a card still pending from a draw (which also resolves the
 * rest of that draw into the hand).
 *
 * The body may carry an optional `reason: "cannot_play"` — the "Can't play,
 * discard" shortcut a team uses when a held card cannot meet its playing
 * requirements. While that team's open Use It or Lose It challenge has a live
 * Fairest offer pending, the Fairest decision must resolve first, so
 * {@link checkCannotPlayDiscard} rejects the shortcut with `conflict` and nothing
 * is written (R5.5). The guard runs on the loaded snapshot before the deck
 * transition, so a rejection commits no domain rows or mutation event (the
 * step-3 transition events still commit).
 *
 * The whole thing is one transaction: the shared pipeline preamble
 * ({@link loadCardMutationContext}: authorize + lock, server `now`, lazy settle,
 * load {@link BehaviorState}), the pure `discardCard` transition, the embedded
 * inventory follow-up, and the `card_discarded` event all commit together
 * (R19.9, R19.10). Discarding can clear the hand's last Fairest of Them All
 * (voiding its pending offers) or empty the hand and pending draw (completing an
 * open Use It or Lose It); {@link settleInventoryChange} computes those follow-ups
 * against the post-transition deck so they ride on the single `card_discarded`
 * inventory event (R8.3, R8.5, R9.12).
 *
 * The pure engine owns the discard rules — it rejects an unknown card
 * (`unknown_card`) or one that is neither pending nor in hand (`card_not_in_hand`)
 * — and this route maps those to structured 4xx responses.
 *
 * Mirrors the claims / keep routes: `runtime = "nodejs"` and the privileged
 * in-transaction connection.
 *
 * Requirements: 1.2, 2.4, 5.5, 8.3, 8.4, 8.5, 9.12, 17.2, 19.9, 19.10.
 */
import { withTransaction } from "@/lib/db/server";
import {
  loadDeckStateWithOrigin,
  persistDeckTransition,
} from "@/lib/cards/persistence";
import { discardCard } from "@/lib/cards/deck";
import {
  checkCannotPlayDiscard,
  settleInventoryChange,
} from "@/lib/cards/challenges";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, loadCardMutationContext } from "../_shared";

export const runtime = "nodejs";

interface DiscardBody {
  /** The held or pending card id to discard (engine id `${teamId}:${slug}`). */
  readonly cardId?: unknown;
  /**
   * Optional discard reason. `"cannot_play"` is the "Can't play, discard"
   * shortcut, guarded by {@link checkCannotPlayDiscard} while a Fairest decision
   * is pending (R5.5). Any other / absent value is an ordinary discard.
   */
  readonly reason?: unknown;
}

type DiscardOutcome =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<Response> {
  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }

  let body: DiscardBody;
  try {
    body = (await request.json()) as DiscardBody;
  } catch {
    return notApplied("invalid_card");
  }
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) {
    return notApplied("invalid_card");
  }
  const cannotPlay = body.reason === "cannot_play";

  try {
    const outcome = await withTransaction<DiscardOutcome>(async (tx) => {
      const ctx = await loadCardMutationContext(tx, gameId, session.sessionId);
      if (!ctx.ok) {
        return { ok: false, reason: ctx.reason };
      }
      const { teamId, nowIso, state } = ctx;

      // "Can't play, discard" shortcut: reject while a Fairest decision for the
      // team's open UIOLI challenge is still pending (R5.5). Runs before any
      // write, so a rejection leaves no domain rows or mutation event.
      if (cannotPlay) {
        const guard = checkCannotPlayDiscard(state, teamId);
        if (!guard.ok) {
          return { ok: false, reason: guard.error };
        }
      }

      const { state: before, seeded } = await loadDeckStateWithOrigin(tx, {
        gameId,
        teamId,
      });
      const result = discardCard(before, cardId);
      if (!result.ok) {
        return { ok: false, reason: deckRejectionReason(result.reason) };
      }

      const inventoryFollowUp = settleInventoryChange(
        state,
        teamId,
        result.state,
        nowIso,
      );

      const seq = await persistDeckTransition(tx, {
        ctx: { gameId, teamId },
        kind: "discard",
        before,
        after: result.state,
        seeded,
        inventoryFollowUp,
      });
      return { ok: true, seq };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch {
    return notApplied("unavailable");
  }
}
