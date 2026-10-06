/**
 * Durable bar claim mutation route.
 *
 * Claims, score adjustments, canonical events, and the finish-bar lifecycle
 * transition all run through one transaction. The request only attests to the
 * team's presence and completed drinks; the server derives the player and team
 * from the session and counts assigned members from durable state.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import { evaluateClaimEligibility, type ClaimEligibility } from "@/lib/claims";
import {
  computeShareAdjustments,
  type ClaimScoringBarKind,
  type ScoreAdjustment,
} from "@/lib/scoring";

import {
  assertMember,
  notApplied,
  requireSession,
  type LobbyErrorReason,
} from "@/app/api/games/_shared";

export const runtime = "nodejs";

interface ClaimsBody {
  readonly action?: unknown;
  readonly barId?: unknown;
  readonly allMembersPresent?: unknown;
  readonly finishedDrinkCount?: unknown;
}

type ClaimAction = "claim" | "unclaim";

type ClaimOutcome =
  | { readonly ok: true; readonly seq: number; readonly claimId: string }
  | { readonly ok: false; readonly reason: LobbyErrorReason };

interface GameState {
  readonly lifecycle: "lobby" | "live" | "ended";
  readonly startBarId: string | null;
  readonly finishBarId: string | null;
}

const GAME_STATE_SQL = `
select lifecycle, start_bar_id, finish_bar_id
from games
where id = $1
`;

const PLAYER_SQL = `
select id, team_id
from players
where game_id = $1 and session_id = $2
limit 1
`;

const TEAM_MEMBER_COUNT_SQL = `
select count(*)::int as member_count
from players
where game_id = $1 and team_id = $2
`;

const BAR_SQL = `
select id
from bars
where game_id = $1
  and (
    id::text = $2
    or trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))) = lower($2)
  )
limit 1
`;

const ACTIVE_CLAIMS_SQL = `
select id, team_id
from claims
where game_id = $1 and bar_id = $2 and revoked_at is null
order by claimed_at, id
for update
`;

const INSERT_CLAIM_SQL = `
insert into claims (game_id, team_id, bar_id)
values ($1, $2, $3)
returning id
`;

const REVOKE_CLAIM_SQL = `
update claims
set revoked_at = now(), revoked_reason = 'ordinary_unclaim'
where id = $1 and game_id = $2 and revoked_at is null
returning id
`;

const INSERT_LEDGER_SQL = `
insert into score_ledger_entries
  (game_id, team_id, bar_id, source_claim_id, category, points, metadata)
values ($1, $2, $3, $4, $5, $6, $7::jsonb)
returning id
`;

const END_FINISH_GAME_SQL = `
update games
set lifecycle = 'ended', end_reason = 'finish_bar_claimed'
where id = $1 and lifecycle = 'live'
returning id
`;

function readAction(value: unknown): ClaimAction | undefined {
  return value === "claim" || value === "unclaim" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readAttestation(
  body: ClaimsBody,
):
  | { readonly allMembersPresent: boolean; readonly finishedDrinkCount: number }
  | undefined {
  if (
    typeof body.allMembersPresent !== "boolean" ||
    typeof body.finishedDrinkCount !== "number" ||
    !Number.isInteger(body.finishedDrinkCount) ||
    body.finishedDrinkCount < 0
  ) {
    return undefined;
  }
  return {
    allMembersPresent: body.allMembersPresent,
    finishedDrinkCount: body.finishedDrinkCount,
  };
}

function gameState(row: Record<string, unknown>): GameState {
  return {
    lifecycle: row.lifecycle as GameState["lifecycle"],
    startBarId: row.start_bar_id == null ? null : String(row.start_bar_id),
    finishBarId: row.finish_bar_id == null ? null : String(row.finish_bar_id),
  };
}

function barKind(game: GameState, barId: string): ClaimScoringBarKind {
  if (game.startBarId === barId) return "start";
  if (game.finishBarId === barId) return "finish";
  return "scoring";
}

async function appendScoreAdjustments(
  tx: QueryRunner,
  gameId: string,
  barId: string,
  sourceClaimId: string,
  adjustments: readonly ScoreAdjustment[],
): Promise<number> {
  let lastSeq = 0;
  for (const adjustment of adjustments) {
    const { rows } = await tx.query(INSERT_LEDGER_SQL, [
      gameId,
      adjustment.teamId,
      barId,
      sourceClaimId,
      adjustment.category,
      adjustment.points,
      { sourceClaimId },
    ]);
    const entryId = String(rows[0]?.id);
    const event = await appendEvent(tx, {
      gameId,
      type:
        adjustment.category === "bar_share_correction"
          ? GAME_BOARD_EVENT_TYPES.scoreModifierApplied
          : GAME_BOARD_EVENT_TYPES.scoreAwarded,
      actor: { kind: "team", teamId: adjustment.teamId },
      payload: {
        entryId,
        teamId: adjustment.teamId,
        barId,
        sourceClaimId,
        category: adjustment.category,
        points: adjustment.points,
      },
    });
    lastSeq = event.seq;
  }
  return lastSeq;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ gameId: string }> },
): Promise<NextResponse> {
  const session = requireSession(request);
  if (!session.ok) return notApplied(session.reason);

  const gameId = (await context.params).gameId.trim();
  if (!gameId) return notApplied("invalid_claim");

  let body: ClaimsBody;
  try {
    body = (await request.json()) as ClaimsBody;
  } catch {
    return notApplied("invalid_claim");
  }

  const action = readAction(body.action);
  const barId = readString(body.barId);
  if (!action || !barId) return notApplied("invalid_claim");
  const attestation = action === "claim" ? readAttestation(body) : undefined;
  if (action === "claim" && !attestation) {
    return notApplied("invalid_claim");
  }

  try {
    const outcome = await withTransaction<ClaimOutcome>(async (tx) => {
      if (!(await assertMember(tx, gameId, session.sessionId))) {
        return { ok: false, reason: "not_member" };
      }

      const { rows: gameRows } = await tx.query(GAME_STATE_SQL, [gameId]);
      const game = gameRows[0] ? gameState(gameRows[0]) : null;
      if (!game) return { ok: false, reason: "not_found" };
      if (game.lifecycle !== "live") return { ok: false, reason: "not_live" };

      const { rows: barRows } = await tx.query(BAR_SQL, [gameId, barId]);
      if (barRows.length === 0) return { ok: false, reason: "not_found" };
      // The map uses stable name slugs, while the database stores UUID bar ids.
      // Keep the submitted value for board event payloads and use the resolved
      // UUID for foreign-keyed claims, ledger entries, and lifecycle checks.
      const resolvedBarId = String(barRows[0]?.id ?? barId);

      const { rows: playerRows } = await tx.query(PLAYER_SQL, [
        gameId,
        session.sessionId,
      ]);
      const teamId = playerRows[0]?.team_id;
      if (teamId == null) return { ok: false, reason: "no_team" };
      const resolvedTeamId = String(teamId);

      const { rows: activeRows } = await tx.query(ACTIVE_CLAIMS_SQL, [
        gameId,
        resolvedBarId,
      ]);
      const previousTeamIds = activeRows.map((row) => String(row.team_id));

      if (action === "unclaim") {
        const active = activeRows.find(
          (row) => String(row.team_id) === resolvedTeamId,
        );
        if (!active) return { ok: false, reason: "claim_not_active" };
        if (barKind(game, resolvedBarId) === "finish") {
          return { ok: false, reason: "not_live" };
        }

        const { rows: revokedRows } = await tx.query(REVOKE_CLAIM_SQL, [
          String(active.id),
          gameId,
        ]);
        if (revokedRows.length !== 1) {
          return { ok: false, reason: "claim_not_active" };
        }
        const nextTeamIds = previousTeamIds.filter(
          (id) => id !== resolvedTeamId,
        );
        const adjustments = computeShareAdjustments({
          barKind: barKind(game, resolvedBarId),
          previousClaimingTeamIds: previousTeamIds,
          nextClaimingTeamIds: nextTeamIds,
        });
        const claimEvent = await appendEvent(tx, {
          gameId,
          type: GAME_BOARD_EVENT_TYPES.claimRemoved,
          actor: { kind: "team", teamId: resolvedTeamId },
          payload: {
            claimId: String(active.id),
            teamId: resolvedTeamId,
            barId,
            reason: "ordinary_unclaim",
          },
        });
        const scoreSeq = await appendScoreAdjustments(
          tx,
          gameId,
          resolvedBarId,
          String(active.id),
          adjustments,
        );
        return {
          ok: true,
          seq: scoreSeq || claimEvent.seq,
          claimId: String(active.id),
        };
      }

      if (previousTeamIds.includes(resolvedTeamId)) {
        return { ok: false, reason: "claim_duplicate" };
      }

      const { rows: memberRows } = await tx.query(TEAM_MEMBER_COUNT_SQL, [
        gameId,
        resolvedTeamId,
      ]);
      const teamMemberCount = Number(memberRows[0]?.member_count ?? 0);
      const eligibility: ClaimEligibility = evaluateClaimEligibility({
        teamMemberCount,
        finishedDrinkCount: attestation?.finishedDrinkCount ?? 0,
        allMembersPresent: attestation?.allMembersPresent ?? false,
      });
      if (!eligibility.eligible) {
        return { ok: false, reason: "claim_ineligible" };
      }

      const { rows: claimRows } = await tx.query(INSERT_CLAIM_SQL, [
        gameId,
        resolvedTeamId,
        resolvedBarId,
      ]);
      const claimId = String(claimRows[0]?.id);
      const nextTeamIds = [...previousTeamIds, resolvedTeamId];
      const adjustments = computeShareAdjustments({
        barKind: barKind(game, resolvedBarId),
        previousClaimingTeamIds: previousTeamIds,
        nextClaimingTeamIds: nextTeamIds,
      });
      const claimEvent = await appendEvent(tx, {
        gameId,
        type: GAME_BOARD_EVENT_TYPES.claimRecorded,
        actor: { kind: "team", teamId: resolvedTeamId },
        payload: {
          claimId,
          teamId: resolvedTeamId,
          barId,
          activeTeamIds: nextTeamIds,
        },
      });
      const scoreSeq = await appendScoreAdjustments(
        tx,
        gameId,
        resolvedBarId,
        claimId,
        adjustments,
      );

      if (barKind(game, resolvedBarId) === "finish") {
        const { rows: endedRows } = await tx.query(END_FINISH_GAME_SQL, [
          gameId,
        ]);
        if (endedRows.length !== 1) {
          throw new Error("claim finish: game was no longer live");
        }
        const endedEvent = await appendEvent(tx, {
          gameId,
          type: GAME_BOARD_EVENT_TYPES.gameEnded,
          actor: { kind: "team", teamId: resolvedTeamId },
          payload: {
            endReason: "finish_bar_claimed",
            finishBarId: barId,
            claimingTeamId: resolvedTeamId,
          },
        });
        return { ok: true, seq: endedEvent.seq, claimId };
      }

      return { ok: true, seq: scoreSeq || claimEvent.seq, claimId };
    });

    if (!outcome.ok) return notApplied(outcome.reason);
    return NextResponse.json(
      { applied: true, seq: outcome.seq, result: { claimId: outcome.claimId } },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "claim failed";
    return NextResponse.json(
      { applied: false, error: message },
      { status: 500 },
    );
  }
}
