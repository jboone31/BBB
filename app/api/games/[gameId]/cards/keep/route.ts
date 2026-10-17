/**
 * Keep-card route (brawl-deck-architecture Task 5).
 *
 * POST /api/games/{gameId}/cards/keep — the requesting team resolves its pending
 * draw by keeping exactly one of the two drawn cards; the engine discards the
 * rest (R1.2). The whole thing is one transaction: the deck transition and its
 * `card_kept` event commit together, so a failure writes neither.
 *
 * The pure engine (`keepCard`) owns the rules — it rejects when there is no
 * pending draw (`pending_draw`) or when the named card is not one of the pending
 * cards (`card_not_pending`) — and this route turns those into structured 409s.
 * This enforces that a pending draw is resolved before the team's next draw,
 * consistent with the engine's `drawForBar` `pending_draw` rejection.
 *
 * Mirrors the claims / wireframe routes: `runtime = "nodejs"` (the postgres.js
 * driver needs a real socket) and the privileged in-transaction connection.
 *
 * Requirements: 1.2, 2.4.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { applyDeckTransition } from "@/lib/cards/persistence";
import { keepCard } from "@/lib/cards/deck";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, resolveCardActor } from "../_shared";

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
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }

      const result = await applyDeckTransition(tx, {
        ctx: { gameId, teamId: actor.teamId },
        kind: "keep",
        transition: (state) => keepCard(state, cardId),
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
    const message = err instanceof Error ? err.message : "keep failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
