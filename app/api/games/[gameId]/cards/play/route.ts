/**
 * Real card-play route (brawl-deck-architecture Task 8), replacing the former
 * `wireframe-card-play` path.
 *
 * POST /api/games/{gameId}/cards/play — the requesting team plays a card from its
 * hand, optionally targeting another team and/or a bar. In one transaction it:
 *   1. authorizes the requester and resolves its team (shared card preamble);
 *   2. validates the target(s): a team target must belong to the game, differ
 *      from the caster, and NOT already have been targeted by a card of the same
 *      name (R3.3) — the same eligibility the UI grays out (R3.2), enforced here
 *      on the server;
 *   3. applies the pure `playCard` transition (removing the card from hand,
 *      R3.1) and appends one canonical `card_played` event carrying the chosen
 *      target(s) and the card slug.
 *
 * The committed event propagates over the existing Realtime backbone, so the
 * target team's clients see the play without a refresh (R3.7). This route does
 * NOT implement any card's downstream effect — that is a later per-card effort;
 * it writes the authoritative play + targeting fact and removes the card.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { rowToGameEvent } from "@/lib/events";
import {
  applyDeckTransition,
  slugFromEngineCardId,
} from "@/lib/cards/persistence";
import { playCard } from "@/lib/cards/deck";
import { getCardMetadata, type CardSlug } from "@/lib/cards/catalog";
import { foldGameBoardEvents } from "@/lib/gameboard/events";
import { isTeamTargetEligible } from "@/lib/gameboard/cardEligibility";

import {
  applied,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

import { deckRejectionReason, resolveCardActor } from "../_shared";

export const runtime = "nodejs";

interface PlayBody {
  /** The held card id to play (engine id `${teamId}:${slug}`). */
  readonly cardId?: unknown;
  /** The target team id, when the card targets a team. */
  readonly targetTeamId?: unknown;
  /** The target bar id, when the card targets a bar. */
  readonly targetBarId?: unknown;
}

type PlayOutcome =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

const TEAM_IN_GAME_SQL = `
select 1
from teams
where id = $1 and game_id = $2
limit 1
`;

const EVENTS_SQL = `
select id, game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at
from game_events
where game_id = $1
order by seq
`;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The card's declared target mode, or undefined if the slug is unknown. */
function targetModeOf(slug: string): string | undefined {
  try {
    return getCardMetadata(slug as CardSlug).targetMode;
  } catch {
    return undefined;
  }
}

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

  let body: PlayBody;
  try {
    body = (await request.json()) as PlayBody;
  } catch {
    return notApplied("invalid_card");
  }
  const cardId = readString(body.cardId);
  if (cardId === undefined) {
    return notApplied("invalid_card");
  }
  const targetTeamId = readString(body.targetTeamId);
  const targetBarId = readString(body.targetBarId);
  const slug = slugFromEngineCardId(cardId);
  const targetMode = targetModeOf(slug);

  try {
    const outcome = await withTransaction<PlayOutcome>(async (tx) => {
      const actor = await resolveCardActor(tx, gameId, session.sessionId);
      if (!actor.ok) {
        return { ok: false, reason: actor.reason };
      }
      const castingTeamId = actor.teamId;

      // Validate a team target: belongs to the game, is not the caster, and is
      // not already targeted by a card of the same name (R3.2/R3.3). The same
      // eligibility the UI uses to gray out teams, enforced on the server.
      const targetsTeam =
        targetMode === "team" || targetMode === "team_and_bar";
      if (targetsTeam) {
        if (targetTeamId === undefined) {
          return { ok: false, reason: "invalid_card" };
        }
        if (targetTeamId === castingTeamId) {
          return { ok: false, reason: "invalid_card" };
        }
        const { rows: teamRows } = await tx.query(TEAM_IN_GAME_SQL, [
          targetTeamId,
          gameId,
        ]);
        if (teamRows.length === 0) {
          return { ok: false, reason: "not_found" };
        }
        // Fold the current event log to evaluate the same-name-once rule
        // against committed plays, inside this transaction.
        const { rows: eventRows } = await tx.query(EVENTS_SQL, [gameId]);
        const events = eventRows.map((row) => rowToGameEvent(row));
        const view = foldGameBoardEvents(gameId, events);
        if (
          !isTeamTargetEligible(
            view,
            slug as CardSlug,
            castingTeamId,
            targetTeamId,
          )
        ) {
          return { ok: false, reason: "target_ineligible" };
        }
      }

      // Apply the pure play transition (removes the card from hand, R3.1) and
      // append one card_played carrying the targets + slug. The engine rejects
      // a card not in hand / unknown card.
      const result = await applyDeckTransition(tx, {
        ctx: { gameId, teamId: castingTeamId },
        kind: "play",
        transition: (state) => playCard(state, cardId),
        eventExtra: {
          castingTeamId,
          slug,
          targetTeamId: targetTeamId ?? null,
          targetBarId: targetBarId ?? null,
        },
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
    const message = err instanceof Error ? err.message : "play failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
