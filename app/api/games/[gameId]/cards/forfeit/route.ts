/**
 * Forfeit-draw route (brawl-deck-architecture UAT hotfix: hand-full flow).
 *
 * POST /api/games/{gameId}/cards/forfeit — the requesting team forfeits its
 * current pending draw, discarding BOTH drawn cards without keeping either
 * (R2.4). This is the explicit escape for a player whose hand is full and who
 * would rather drop the draw than free a slot. The engine's `forfeitDraw` owns
 * the rule — it rejects when there is no pending draw (`pending_draw`) — and
 * this route turns that into a structured 409.
 *
 * The forfeited cards are discarded for the rest of the game and the draw's bar
 * stays recorded, so the once-per-bar rule still holds. The transition and its
 * `card_discarded` event commit together in one transaction.
 *
 * Mirrors the keep / discard routes: `runtime = "nodejs"` and the privileged
 * in-transaction connection.
 *
 * Requirements: 1.2, 2.4.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { applyDeckTransition } from "@/lib/cards/persistence";
import { forfeitDraw } from "@/lib/cards/deck";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, resolveCardActor } from "../_shared";

export const runtime = "nodejs";

type ForfeitOutcome =
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

  try {
    const outcome = await withTransaction<ForfeitOutcome>(async (tx) => {
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }

      const result = await applyDeckTransition(tx, {
        ctx: { gameId, teamId: actor.teamId },
        kind: "discard",
        transition: (state) => forfeitDraw(state),
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
    const message = err instanceof Error ? err.message : "forfeit failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
