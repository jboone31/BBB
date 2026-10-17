/**
 * Discard-card route (brawl-deck-architecture Task 5).
 *
 * POST /api/games/{gameId}/cards/discard — the requesting team discards one card
 * it holds. The engine's `discardCard` accepts either a card in hand (freeing a
 * hand slot — R2.4) or a card still pending from a draw (which also resolves the
 * rest of that draw into the hand). The transition and its `card_discarded`
 * event commit together in one transaction.
 *
 * The pure engine owns the rules — it rejects an unknown card (`unknown_card`) or
 * one that is neither pending nor in hand (`card_not_in_hand`) — and this route
 * maps those to structured 4xx responses.
 *
 * Mirrors the claims / keep routes: `runtime = "nodejs"` and the privileged
 * in-transaction connection.
 *
 * Requirements: 1.2, 2.4.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { applyDeckTransition } from "@/lib/cards/persistence";
import { discardCard } from "@/lib/cards/deck";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, resolveCardActor } from "../_shared";

export const runtime = "nodejs";

interface DiscardBody {
  /** The held or pending card id to discard (engine id `${teamId}:${slug}`). */
  readonly cardId?: unknown;
}

type DiscardOutcome =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
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

  try {
    const outcome = await withTransaction<DiscardOutcome>(async (tx) => {
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }

      const result = await applyDeckTransition(tx, {
        ctx: { gameId, teamId: actor.teamId },
        kind: "discard",
        transition: (state) => discardCard(state, cardId),
      });
      if (!result.ok) {
        return { ok: false, reason: deckRejectionReason(result.reason) };
      }
      return { ok: true, seq: result.seq };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch (err) {
    const message = err instanceof Error ? err.message : "discard failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
