/**
 * Keep-card route (brawl-deck-architecture Task 5), reworked onto the
 * Card_Behavior_Mutation pipeline (card-behavior Task 7.3).
 *
 * POST /api/games/{gameId}/cards/keep — the requesting team resolves its pending
 * draw by keeping exactly one of the two drawn cards; the engine discards the
 * rest (R1.2). Under Power Hour's `keep_all` pending mode the engine keeps every
 * pending card instead, moving only the chosen one into the hand and leaving the
 * rest pending for the team to keep one at a time (R17.2) — the mode is carried
 * on the loaded deck state, so the engine honors it without the route deciding.
 *
 * The whole thing is one transaction: the shared pipeline preamble
 * ({@link loadCardMutationContext}: authorize + lock, server `now`, lazy settle,
 * load {@link BehaviorState}), the pure `keepCard` transition, the embedded
 * inventory follow-up, and the `card_kept` event all commit together, so a
 * failure writes neither (R19.9, R19.10).
 *
 * The pure engine (`keepCard`) owns the rules — it rejects when there is no
 * pending draw (`pending_draw`), when the named card is not one of the pending
 * cards (`card_not_pending`), or when the hand is full (`hand_full`) — and this
 * route turns those into structured 409s. Keeping a card can clear the hand's
 * last Fairest of Them All (voiding its pending offers) or empty the hand and
 * pending draw (completing an open Use It or Lose It); {@link settleInventoryChange}
 * computes those follow-ups against the post-transition deck so they ride on the
 * single `card_kept` inventory event (R8.3, R8.5, R9.12).
 *
 * Mirrors the claims / wireframe routes: `runtime = "nodejs"` (the postgres.js
 * driver needs a real socket) and the privileged in-transaction connection.
 *
 * Requirements: 1.2, 2.4, 8.3, 8.4, 8.5, 9.12, 17.2, 19.9, 19.10.
 */
import { withTransaction } from "@/lib/db/server";
import {
  loadDeckStateWithOrigin,
  persistDeckTransition,
} from "@/lib/cards/persistence";
import { keepCard } from "@/lib/cards/deck";
import { settleInventoryChange } from "@/lib/cards/challenges";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, loadCardMutationContext } from "../_shared";

export const runtime = "nodejs";

interface KeepBody {
  /** The pending card id to keep (engine id `${teamId}:${slug}`). */
  readonly cardId?: unknown;
}

type KeepOutcome =
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

  let body: KeepBody;
  try {
    body = (await request.json()) as KeepBody;
  } catch {
    return notApplied("invalid_card");
  }
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) {
    return notApplied("invalid_card");
  }

  try {
    const outcome = await withTransaction<KeepOutcome>(async (tx) => {
      const ctx = await loadCardMutationContext(tx, gameId, session.sessionId);
      if (!ctx.ok) {
        return { ok: false, reason: ctx.reason };
      }
      const { teamId, nowIso, state } = ctx;

      const { state: before, seeded } = await loadDeckStateWithOrigin(tx, {
        gameId,
        teamId,
      });
      const result = keepCard(before, cardId);
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
        kind: "keep",
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
