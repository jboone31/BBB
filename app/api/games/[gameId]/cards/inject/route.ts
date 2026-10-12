/**
 * Dev-only card-injection route (brawl-deck-architecture Task 10; R5.2, R5.3).
 *
 * POST /api/games/{gameId}/cards/inject — adds a chosen card slug directly to the
 * requesting team's hand, IGNORING the hand-size limit, for testing. This is a
 * dev-mode capability: it is authorized ONLY when the committed
 * `DEV_CARD_INJECTION` flag (`lib/config/devFlags.ts`) is true.
 *
 * The flag is enforced HERE on the server, not merely hidden in the UI (R5.3):
 * when the flag is false the route refuses the operation (404, as if it did not
 * exist) even if called directly, so flipping the committed constant is the only
 * way to enable injection — a reviewable code change / PR.
 *
 * When enabled, it runs the same authorized, transactional path as the other
 * card routes and appends a canonical `card_kept` event so the board projection
 * folds the injected card like any real hand card.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { injectCardToHand } from "@/lib/cards/persistence";
import { CARD_SLUGS, type CardSlug } from "@/lib/cards/catalog";
import { isDevCardInjectionEnabled } from "@/lib/config/devFlags";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { resolveCardActor } from "../_shared";

export const runtime = "nodejs";

interface InjectBody {
  /** The catalog slug to add to the requesting team's hand. */
  readonly slug?: unknown;
}

type InjectOutcome =
  | { readonly ok: true; readonly seq: number; readonly cardId: string }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

function isCardSlug(value: unknown): value is CardSlug {
  return typeof value === "string" && CARD_SLUGS.includes(value as CardSlug);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  // Server-enforced flag gate (R5.3): when off, the capability does not exist.
  // Refuse before reading the session/body so it is indistinguishable from an
  // absent route.
  if (!isDevCardInjectionEnabled()) {
    return notApplied("not_found");
  }

  const session = requireSession(request);
  if (!session.ok) {
    return notApplied(session.reason);
  }

  const { gameId: rawGameId } = await context.params;
  const gameId = typeof rawGameId === "string" ? rawGameId.trim() : "";
  if (!gameId) {
    return notApplied("not_found");
  }

  let body: InjectBody;
  try {
    body = (await request.json()) as InjectBody;
  } catch {
    return notApplied("invalid_card");
  }
  if (!isCardSlug(body.slug)) {
    return notApplied("invalid_card");
  }
  const slug = body.slug;

  try {
    const outcome = await withTransaction<InjectOutcome>(async (tx) => {
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }
      const result = await injectCardToHand(
        tx,
        { gameId, teamId: actor.teamId },
        slug,
      );
      if (!result.ok) {
        return { ok: false, reason: "invalid_card" };
      }
      return { ok: true, seq: result.seq, cardId: result.cardId };
    });

    if (!outcome.ok) {
      return notApplied(outcome.reason);
    }
    return applied(outcome.seq);
  } catch (err) {
    const message = err instanceof Error ? err.message : "inject failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
