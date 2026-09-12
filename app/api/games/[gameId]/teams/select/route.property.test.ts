import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";

import type { GameEvent } from "@/lib/events";
import {
  applyLobbyEvent,
  foldLobbyEvents,
  LOBBY_EVENT_TYPES,
  type LobbyView,
} from "@/lib/lobby/events";

/**
 * Feature: game-setup-lobby, Property 16: Team switch yields exactly one team
 * association (Task 17.1).
 *
 * *For any* Player — teamless or already on some Team — and any target Team in
 * the same Game, after a join/switch the Player is associated with exactly the
 * target Team and is no longer associated with any previous Team. From a
 * teamless Player the prior association is empty (`fromTeamId` is null); the
 * result is still exactly one association.
 *
 * Validates: Requirements 4.1, 4.5.
 *
 * The team-select/switch route (`app/api/games/[gameId]/teams/select/route.ts`)
 * enforces this in a single transaction: it runs `UPDATE players SET team_id =
 * $target` (the composite FK keeps the team in the same game) and appends
 * exactly one `team_changed` event `{ playerId, fromTeamId, toTeamId }`. The
 * "exactly one association" guarantee is observable at two layers, so this suite
 * covers both:
 *
 *   1. MODEL LAYER (always runs, no database): the association a client sees is
 *      derived by folding the `team_changed` event through the pure lobby
 *      reducer (`lib/lobby/events.ts`). This layer drives that reducer over an
 *      arbitrary prior state (teamless or on some existing team) and an
 *      arbitrary target team, asserting the folded roster shows the player on
 *      exactly the target team and on no other — matching the pure/route-level
 *      property convention used by the sibling lobby suites.
 *
 *   2. DB LAYER (env-gated; skips cleanly when SUPABASE_DB_URL is unset, mirrors
 *      `supabase/__tests__/playersTeamNullable.test.ts`): exercises the actual
 *      persisted invariant. Because `players.team_id` is a single-valued column,
 *      the route's `UPDATE` makes exactly one association true by construction;
 *      this layer confirms the column ends up holding exactly the target team
 *      for both the teamless-first-selection (R4.1) and switch (R4.5) cases.
 */

// ---------------------------------------------------------------------------
// MODEL LAYER — always runs, no database.
// ---------------------------------------------------------------------------

/** Small identifier-ish string generator (matches the sibling lobby suites). */
const idArb = (prefix: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 9999 }).map((n) => `${prefix}${n}`);

/**
 * Build the lobby event log leading up to (but not including) the join/switch
 * under test: the game is created, two-to-four teams are created, and a single
 * player joins (teamless). Optionally the player is first placed on one of the
 * existing teams via a `team_changed`, so the switch case (R4.5) starts from a
 * real prior association rather than from teamless (R4.1).
 *
 * Returns the built log plus the ids the assertion needs: the player, every
 * team, and the team the player currently sits on (`null` when teamless).
 */
interface PriorState {
  readonly gameId: string;
  readonly log: GameEvent[];
  readonly playerId: string;
  readonly teamIds: readonly string[];
  readonly currentTeamId: string | null;
}

const priorStateArb: fc.Arbitrary<PriorState> = fc
  .record({
    gameId: fc.uuid(),
    playerId: idArb("p"),
    // 2..4 distinct teams, so there is always a "previous" and a "target".
    teamCount: fc.integer({ min: 2, max: 4 }),
    // Whether the player already sits on a team before the join/switch, and if
    // so which one (index into the team list).
    startsOnTeam: fc.boolean(),
    startTeamIndex: fc.integer({ min: 0, max: 3 }),
  })
  .map(({ gameId, playerId, teamCount, startsOnTeam, startTeamIndex }) => {
    const teamIds = Array.from({ length: teamCount }, (_, i) => `t-${i}`);
    const log: GameEvent[] = [];
    let seq = 0;
    const push = (
      eventType: string,
      payload: unknown,
      actorTeamId: string | null = null,
    ): void => {
      seq += 1;
      log.push({
        id: `${gameId}-e${seq}`,
        gameId,
        seq,
        eventType,
        actorKind: actorTeamId === null ? "admin" : "team",
        actorTeamId,
        payload,
        createdAt: new Date(seq).toISOString(),
      });
    };

    push(LOBBY_EVENT_TYPES.gameCreated, { joinCode: "JOINME1" });
    teamIds.forEach((teamId, i) =>
      push(LOBBY_EVENT_TYPES.teamCreated, {
        teamId,
        name: `Team ${i}`,
        color: `#color${i}`,
      }),
    );
    push(LOBBY_EVENT_TYPES.playerJoined, { playerId, displayName: "Ada" });

    let currentTeamId: string | null = null;
    if (startsOnTeam) {
      currentTeamId = teamIds[startTeamIndex % teamIds.length];
      push(
        LOBBY_EVENT_TYPES.teamChanged,
        { playerId, fromTeamId: null, toTeamId: currentTeamId },
        currentTeamId,
      );
    }

    return { gameId, log, playerId, teamIds, currentTeamId };
  });

/**
 * Count how many teams in the folded view list `playerId` in their roster, and
 * collect the `teamId` recorded on the player itself. "Exactly one association"
 * means: the player's `teamId` is the target, and exactly the target team's
 * roster contains the player.
 */
function associations(
  view: LobbyView,
  playerId: string,
): {
  playerTeamId: string | null;
  teamsListingPlayer: string[];
} {
  const player = view.players.find((p) => p.id === playerId);
  const teamsListingPlayer = view.teams
    .filter((t) => t.playerIds.includes(playerId))
    .map((t) => t.id);
  return { playerTeamId: player?.teamId ?? null, teamsListingPlayer };
}

describe("team-select route — Team switch yields exactly one team association (Property 16)", () => {
  it("after a join/switch the player is on exactly the target team and no previous team", () => {
    fc.assert(
      fc.property(
        priorStateArb,
        // A seed used to pick the target team (any team, including the current
        // one — re-selecting the same team must still leave exactly one).
        fc.integer({ min: 0, max: 3 }),
        (prior, targetSeed) => {
          const { gameId, log, playerId, teamIds, currentTeamId } = prior;
          const targetTeamId = teamIds[targetSeed % teamIds.length];

          // Fold the prior log, then apply the route's emitted team_changed
          // event: payload { playerId, fromTeamId: <prior or null>, toTeamId }.
          const before = foldLobbyEvents(gameId, log);
          const switchEvent: GameEvent = {
            id: `${gameId}-switch`,
            gameId,
            seq: before.lastSeenSequence + 1,
            eventType: LOBBY_EVENT_TYPES.teamChanged,
            actorKind: "team",
            actorTeamId: targetTeamId,
            payload: {
              playerId,
              fromTeamId: currentTeamId, // null on first selection (R4.1)
              toTeamId: targetTeamId,
            },
            createdAt: new Date(before.lastSeenSequence + 1).toISOString(),
          };
          const after = applyLobbyEvent(before, switchEvent);

          const { playerTeamId, teamsListingPlayer } = associations(
            after,
            playerId,
          );

          // Exactly one association: the player's teamId is the target, and
          // exactly the target team's roster lists the player.
          expect(playerTeamId).toBe(targetTeamId);
          expect(teamsListingPlayer).toEqual([targetTeamId]);

          // No previous association survives: if the player had a different prior
          // team, that team's roster no longer lists the player.
          if (currentTeamId !== null && currentTeamId !== targetTeamId) {
            const prevTeam = after.teams.find((t) => t.id === currentTeamId);
            expect(prevTeam?.playerIds).not.toContain(playerId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("first selection from teamless (fromTeamId null) yields exactly one association (R4.1)", () => {
    fc.assert(
      fc.property(
        priorStateArb.filter((s) => s.currentTeamId === null),
        fc.integer({ min: 0, max: 3 }),
        (prior, targetSeed) => {
          const { gameId, log, playerId, teamIds } = prior;
          const targetTeamId = teamIds[targetSeed % teamIds.length];

          const before = foldLobbyEvents(gameId, log);
          // Precondition: the player is genuinely teamless before selection.
          expect(
            before.players.find((p) => p.id === playerId)?.teamId,
          ).toBeNull();

          const after = applyLobbyEvent(before, {
            id: `${gameId}-first`,
            gameId,
            seq: before.lastSeenSequence + 1,
            eventType: LOBBY_EVENT_TYPES.teamChanged,
            actorKind: "team",
            actorTeamId: targetTeamId,
            payload: { playerId, fromTeamId: null, toTeamId: targetTeamId },
            createdAt: new Date(before.lastSeenSequence + 1).toISOString(),
          });

          const { playerTeamId, teamsListingPlayer } = associations(
            after,
            playerId,
          );
          expect(playerTeamId).toBe(targetTeamId);
          expect(teamsListingPlayer).toEqual([targetTeamId]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// DB LAYER — env-gated; skips cleanly when SUPABASE_DB_URL is unset.
//
// `lib/db/server.ts` imports `server-only`, which only resolves inside the
// Next.js bundler, so it is loaded LAZILY (dynamic import) — when this suite is
// skipped the module is never evaluated and the default `npm test` run stays
// green outside a Next build. Mirrors the gating in
// `supabase/__tests__/playersTeamNullable.test.ts`.
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL?.trim();
const LIVE_DB_CONFIGURED = Boolean(DB_URL);

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

describe.skipIf(!LIVE_DB_CONFIGURED)(
  "team-select route — persisted association is single-valued (Property 16, DB)",
  () => {
    afterAll(async () => {
      if (serverDb) await serverDb.closeDb();
    });

    it("UPDATE players SET team_id = target leaves exactly the target association, teamless→team (R4.1) and switch (R4.5)", async () => {
      const { withTransaction } = await db();

      await fc.assert(
        fc.asyncProperty(
          // Whether the player starts teamless (first selection, R4.1) or on
          // team A (switch to team B, R4.5).
          fc.boolean(),
          async (startsOnTeamA) => {
            // Everything is created and mutated inside ONE transaction that is
            // rolled back at the end (via a thrown sentinel), so the property
            // leaves no rows behind across its 100 runs.
            const ROLLBACK = Symbol("rollback");
            const session = `sess-${randomUUID()}`;
            const joinCode = `SEL-${randomUUID().slice(0, 6).toUpperCase()}`;

            try {
              await withTransaction(async (tx) => {
                const g = await tx.query(
                  `insert into games (admin_session_id, join_code)
                     values ($1, $2) returning id`,
                  [session, joinCode],
                );
                const gameId = String((g.rows[0] as { id: string }).id);

                const tA = await tx.query(
                  `insert into teams (game_id, name, color)
                     values ($1, 'A', '#a') returning id`,
                  [gameId],
                );
                const tB = await tx.query(
                  `insert into teams (game_id, name, color)
                     values ($1, 'B', '#b') returning id`,
                  [gameId],
                );
                const teamA = String((tA.rows[0] as { id: string }).id);
                const teamB = String((tB.rows[0] as { id: string }).id);

                // The player starts either teamless (null) or on team A.
                const pr = await tx.query(
                  `insert into players (team_id, game_id, session_id, display_name)
                     values ($1, $2, $3, 'Ada') returning id`,
                  [startsOnTeamA ? teamA : null, gameId, session],
                );
                const playerId = String((pr.rows[0] as { id: string }).id);

                // The route's domain write: associate the player with team B.
                await tx.query(
                  `update players set team_id = $1
                    where game_id = $2 and session_id = $3`,
                  [teamB, gameId, session],
                );

                // Exactly one association persists: the player's single team_id
                // column holds team B and nothing else (a single-valued column
                // cannot encode more than one association).
                const after = await tx.query(
                  `select team_id from players where id = $1`,
                  [playerId],
                );
                expect(after.rows).toHaveLength(1);
                expect(
                  String((after.rows[0] as { team_id: string }).team_id),
                ).toBe(teamB);

                // Roll everything back so the property is side-effect free.
                throw ROLLBACK;
              });
            } catch (err) {
              if (err !== ROLLBACK) throw err;
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  },
);
