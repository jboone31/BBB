/**
 * Phase 3.5/3.6 — DB-backed claim route and finish-race coverage.
 *
 * The suite is gated on SUPABASE_DB_URL and drives the real claim route against
 * Postgres. Each test gets an isolated live game and cleanup cascades all rows.
 * The mocked route suite covers injected append failures; this suite proves the
 * committed state, ledger corrections, and concurrent finish serialization.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());
const SESSION_HEADER = "x-bbb-session-id";

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

type ClaimsRoute = typeof import("@/app/api/games/[gameId]/claims/route");
let claimsRoute: ClaimsRoute | undefined;
async function route(): Promise<ClaimsRoute> {
  claimsRoute ??= await import("@/app/api/games/[gameId]/claims/route");
  return claimsRoute;
}

interface Fixture {
  readonly gameId: string;
  readonly teamAId: string;
  readonly teamBId: string;
  readonly sessionA: string;
  readonly sessionB: string;
  readonly teamlessSession: string;
  readonly startBarId: string;
  readonly finishBarId: string;
  readonly scoringBarId: string;
}

const createdGameIds: string[] = [];

async function createFixture(teamAMemberCount = 1): Promise<Fixture> {
  const adminSession = `it-claims-admin-${randomUUID()}`;
  const sessionA = `it-claims-a-${randomUUID()}`;
  const sessionB = `it-claims-b-${randomUUID()}`;
  const teamlessSession = `it-claims-teamless-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction(async (tx) => {
    const gameResult = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now())
       returning id`,
      [adminSession, `IT${randomUUID()}`],
    );
    const gameId = String(gameResult.rows[0]?.id);

    const teamAResult = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'Claims A', '#e6194b')
       returning id`,
      [gameId],
    );
    const teamAId = String(teamAResult.rows[0]?.id);
    const teamBResult = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'Claims B', '#4363d8')
       returning id`,
      [gameId],
    );
    const teamBId = String(teamBResult.rows[0]?.id);

    for (let index = 0; index < teamAMemberCount; index += 1) {
      await tx.query(
        `insert into players (game_id, team_id, session_id, display_name)
         values ($1, $2, $3, $4)`,
        [
          gameId,
          teamAId,
          index === 0 ? sessionA : `it-claims-a-extra-${randomUUID()}`,
          `Claims A ${index + 1}`,
        ],
      );
    }
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Claims B player')`,
      [gameId, teamBId, sessionB],
    );
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, null, $2, 'Teamless player')`,
      [gameId, teamlessSession],
    );

    const bars: Record<string, string> = {};
    for (const [key, name] of [
      ["start", "Claims Start"],
      ["finish", "Claims Finish"],
      ["scoring", "Claims Scoring"],
    ] as const) {
      const barResult = await tx.query(
        `insert into bars (game_id, name) values ($1, $2) returning id`,
        [gameId, name],
      );
      bars[key] = String(barResult.rows[0]?.id);
    }
    await tx.query(
      `update games
          set start_bar_id = $2, finish_bar_id = $3
        where id = $1`,
      [gameId, bars.start, bars.finish],
    );

    return {
      gameId,
      teamAId,
      teamBId,
      sessionA,
      sessionB,
      teamlessSession,
      startBarId: bars.start,
      finishBarId: bars.finish,
      scoringBarId: bars.scoring,
    };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
}

function context(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

function claimRequest(
  sessionId: string,
  body: Record<string, unknown>,
): Request {
  return new Request("http://localhost/api/games/game/claims", {
    method: "POST",
    headers: {
      [SESSION_HEADER]: sessionId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function postClaim(
  fixture: Fixture,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await route();
  const response = await POST(
    claimRequest(sessionId, body),
    context(fixture.gameId),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function readBarState(
  fixture: Fixture,
  barId: string,
): Promise<{
  activeClaims: number;
  historicalClaims: number;
  ledger: Array<{ team_id: string; points: number; category: string }>;
  eventTypes: string[];
}> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const claims = await tx.query(
      `select revoked_at from claims where game_id = $1 and bar_id = $2`,
      [fixture.gameId, barId],
    );
    const ledger = await tx.query(
      `select team_id, points, category
         from score_ledger_entries
        where game_id = $1 and bar_id = $2
        order by created_at, id`,
      [fixture.gameId, barId],
    );
    const events = await tx.query(
      `select event_type from game_events where game_id = $1 order by seq`,
      [fixture.gameId],
    );
    return {
      activeClaims: claims.rows.filter((row) => row.revoked_at == null).length,
      historicalClaims: claims.rows.length,
      ledger: ledger.rows.map((row) => ({
        team_id: String(row.team_id),
        points: Number(row.points),
        category: String(row.category),
      })),
      eventTypes: events.rows.map((row) => String(row.event_type)),
    };
  });
}

async function readLifecycle(gameId: string): Promise<string> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const result = await tx.query(`select lifecycle from games where id = $1`, [
      gameId,
    ]);
    return String(result.rows[0]?.lifecycle);
  });
}

async function purgeClaimFixtures(): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(
      `alter table game_events disable trigger game_events_no_update_delete`,
    );
    await tx.query(
      `alter table score_ledger_entries disable trigger score_ledger_entries_no_update_delete`,
    );
    await tx.query(
      `delete from games where admin_session_id like 'it-claims-admin-%'`,
    );
    await tx.query(
      `alter table score_ledger_entries enable trigger score_ledger_entries_no_update_delete`,
    );
    await tx.query(
      `alter table game_events enable trigger game_events_no_update_delete`,
    );
    return undefined;
  });
}

describe.skipIf(!DB_CONFIGURED)(
  "claims route DB-backed integration (Phase 3.5/3.6)",
  () => {
    beforeAll(async () => {
      await purgeClaimFixtures();
    }, 30000);

    afterAll(async () => {
      if (serverDb) {
        try {
          if (createdGameIds.length > 0) {
            await serverDb.withTransaction(async (tx) => {
              await tx.query(
                `alter table game_events disable trigger game_events_no_update_delete`,
              );
              await tx.query(
                `alter table score_ledger_entries disable trigger score_ledger_entries_no_update_delete`,
              );
              await tx.query(`delete from games where id = any($1::uuid[])`, [
                createdGameIds,
              ]);
              await tx.query(
                `alter table score_ledger_entries enable trigger score_ledger_entries_no_update_delete`,
              );
              await tx.query(
                `alter table game_events enable trigger game_events_no_update_delete`,
              );
              return undefined;
            });
          }
        } finally {
          await serverDb.closeDb();
        }
      }
    }, 30000);

    it("excludes teamless players and enforces the ceil half-team threshold", async () => {
      const oneMember = await createFixture(1);
      const accepted = await postClaim(oneMember, oneMember.sessionA, {
        action: "claim",
        barId: oneMember.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      const threeMembers = await createFixture(3);
      const rejected = await postClaim(threeMembers, threeMembers.sessionA, {
        action: "claim",
        barId: threeMembers.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      expect(rejected.status).toBe(409);
      expect(rejected.body).toMatchObject({
        applied: false,
        error: "claim_ineligible",
      });

      const acceptedWithHalf = await postClaim(
        threeMembers,
        threeMembers.sessionA,
        {
          action: "claim",
          barId: threeMembers.scoringBarId,
          allMembersPresent: true,
          finishedDrinkCount: 2,
        },
      );
      expect(acceptedWithHalf.status).toBe(200);
    }, 30000);

    it("rejects unauthorized undo, then supports revoke and reclaim", async () => {
      const fixture = await createFixture();
      const claimed = await postClaim(fixture, fixture.sessionA, {
        action: "claim",
        barId: fixture.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);

      const unauthorized = await postClaim(fixture, fixture.sessionB, {
        action: "unclaim",
        barId: fixture.scoringBarId,
      });
      expect(unauthorized.status).toBe(409);
      expect(unauthorized.body).toMatchObject({
        applied: false,
        error: "claim_not_active",
      });

      const revoked = await postClaim(fixture, fixture.sessionA, {
        action: "unclaim",
        barId: fixture.scoringBarId,
      });
      expect(revoked.status).toBe(200);

      const reclaimed = await postClaim(fixture, fixture.sessionA, {
        action: "claim",
        barId: fixture.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      expect(reclaimed.status).toBe(200);

      const state = await readBarState(fixture, fixture.scoringBarId);
      expect(state.activeClaims).toBe(1);
      expect(state.historicalClaims).toBe(2);
    }, 30000);

    it("keeps start-bar score at zero and recomputes ordinary shares", async () => {
      const startFixture = await createFixture();
      const start = await postClaim(startFixture, startFixture.sessionA, {
        action: "claim",
        barId: startFixture.startBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      expect(
        (await readBarState(startFixture, startFixture.startBarId)).ledger,
      ).toEqual([]);

      const fixture = await createFixture();
      await postClaim(fixture, fixture.sessionA, {
        action: "claim",
        barId: fixture.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      await postClaim(fixture, fixture.sessionB, {
        action: "claim",
        barId: fixture.scoringBarId,
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });
      let state = await readBarState(fixture, fixture.scoringBarId);
      expect(
        state.ledger.map((entry) => [entry.team_id, entry.points]),
      ).toEqual(
        expect.arrayContaining([
          [fixture.teamAId, 12],
          [fixture.teamAId, -6],
          [fixture.teamBId, 6],
        ]),
      );

      await postClaim(fixture, fixture.sessionB, {
        action: "unclaim",
        barId: fixture.scoringBarId,
      });
      state = await readBarState(fixture, fixture.scoringBarId);
      const totals = new Map<string, number>();
      for (const entry of state.ledger) {
        totals.set(
          entry.team_id,
          (totals.get(entry.team_id) ?? 0) + entry.points,
        );
      }
      expect(totals.get(fixture.teamAId)).toBe(12);
      expect(totals.get(fixture.teamBId)).toBe(0);
    }, 30000);

    it("awards the finish bar once and serializes competing finish claims", async () => {
      const fixture = await createFixture();
      const [first, second] = await Promise.all([
        postClaim(fixture, fixture.sessionA, {
          action: "claim",
          barId: fixture.finishBarId,
          allMembersPresent: true,
          finishedDrinkCount: 1,
        }),
        postClaim(fixture, fixture.sessionB, {
          action: "claim",
          barId: fixture.finishBarId,
          allMembersPresent: true,
          finishedDrinkCount: 1,
        }),
      ]);

      expect(
        [first.status, second.status].sort(),
        JSON.stringify([first.body, second.body]),
      ).toEqual([200, 409]);
      expect(
        [first.body, second.body].some((body) => body.error === "not_live"),
      ).toBe(true);
      expect(await readLifecycle(fixture.gameId)).toBe("ended");

      const state = await readBarState(fixture, fixture.finishBarId);
      expect(state.activeClaims).toBe(1);
      expect(state.ledger).toHaveLength(1);
      expect(state.ledger[0]?.points).toBe(12);
      expect(
        state.eventTypes.filter((type) => type === "game_ended"),
      ).toHaveLength(1);
      expect(
        state.eventTypes.filter((type) => type === "claim_recorded"),
      ).toHaveLength(1);
    }, 30000);
  },
);
