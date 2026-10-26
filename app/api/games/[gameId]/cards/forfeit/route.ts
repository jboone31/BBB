/**
 * Forfeit-draw route (brawl-deck-architecture UAT hotfix: hand-full flow),
 * reworked onto the Card_Behavior_Mutation pipeline (card-behavior Task 7.3).
 *
 * POST /api/games/{gameId}/cards/forfeit — the requesting team forfeits its
 * current pending draw, discarding BOTH drawn cards without keeping either
 * (R2.4). This is the explicit escape for a player whose hand is full and who
 * would rather drop the draw than free a slot. The engine's `forfeitDraw` owns
 * the rule — it rejects when there is no pending draw (`pending_draw`) — and
 * this route turns that into a structured 409.
 *
 * In one transaction it runs the shared pipeline preamble
 * ({@link loadCardMutationContext}: authorize + lock, server `now`, lazy settle,
 * load {@link BehaviorState}), applies the pure `forfeitDraw` transition, then
 * computes {@link settleInventoryChange} against the post-transition deck so any
 * Use It or Lose It completion and voided Fairest offers ride on the single
 * `card_discarded` inventory event (R8.3, R8.5, R9.12). Forfeiting discards
 * every held/pending card, so an open UIOLI completes and a held Fairest's
 * pending offers void here.
 *
 * The forfeited cards are discarded for the rest of the game and the draw's bar
 * stays recorded, so the once-per-bar rule still holds. The deck transition, the
 * embedded follow-ups, and the `card_discarded` event commit together in one
 * transaction; the step-3 transition events commit with them (and roll back with
 * them on a thrown error — R19.9, R19.10).
 *
 * Mirrors the keep / discard routes: `runtime = "nodejs"` and the privileged
 * in-transaction connection.
 *
 * Requirements: 1.2, 2.4, 8.3, 8.4, 8.5, 9.12, 17.2, 19.9, 19.10.
 */
import { withTransaction } from "@/lib/db/server";
import {
  loadDeckStateWithOrigin,
  persistDeckTransition,
} from "@/lib/cards/persistence";
import { forfeitDraw } from "@/lib/cards/deck";
import { settleInventoryChange } from "@/lib/cards/challenges";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, loadCardMutationContext } from "../_shared";

export const runtime = "nodejs";

type ForfeitOutcome =
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

  try {
    const outcome = await withTransaction<ForfeitOutcome>(async (tx) => {
      const ctx = await loadCardMutationContext(tx, gameId, session.sessionId);
      if (!ctx.ok) {
        return { ok: false, reason: ctx.reason };
      }
      const { teamId, nowIso, state } = ctx;

      // Apply the pure transition to compute the after-deck, so the inventory
      // follow-up planner can read the emptied hand/pending alongside the
      // challenge/offer state loaded in the snapshot.
      const { state: before, seeded } = await loadDeckStateWithOrigin(tx, {
        gameId,
        teamId,
      });
      const result = forfeitDraw(before);
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
    // An uncaught error rolls back the domain rows, the mutation event, and the
    // step-3 transition events together; the next settle re-derives them.
    return notApplied("unavailable");
  }
}
