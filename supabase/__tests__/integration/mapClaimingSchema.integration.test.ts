/**
 * Live Phase 1 checks for reversible claims, the score ledger, and their RLS.
 *
 * This suite is gated on SUPABASE_DB_URL and uses the direct database connection
 * so it can verify the database constraints and append-only trigger directly.
 * It creates and removes one throwaway game in the configured project.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { QueryRunner } from "@/lib/events";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

interface Fixture {
  readonly gameId: string;
  readonly teamId: string;
  readonly sessionId: string;
  readonly barId: string;
  readonly claimId: string;
  readonly ledgerId: string;
}

async function createFixture(): Promise<Fixture> {
  const { withTransaction } = await db();
  const sessionId = `it-claim-${randomUUID()}`;

  return withTransaction(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now())
       returning id`,
      [sessionId, `CLM${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    const gameId = String(game.rows[0]?.id);

    const team = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'Claim Fixture Team', '#123456')
       returning id`,
      [gameId],
    );
    const teamId = String(team.rows[0]?.id);

    await tx.query(
      `insert into players (team_id, game_id, session_id, display_name)
       values ($1, $2, $3, 'Claim Fixture Player')`,
      [teamId, gameId, sessionId],
    );

    const bar = await tx.query(
      `insert into bars (game_id, name)
       values ($1, 'Claim Fixture Bar')
       returning id`,
      [gameId],
    );
    const barId = String(bar.rows[0]?.id);

    const claim = await tx.query(
      `insert into claims (game_id, team_id, bar_id)
       values ($1, $2, $3)
       returning id`,
      [gameId, teamId, barId],
    );
    const claimId = String(claim.rows[0]?.id);

    const ledger = await tx.query(
      `insert into score_ledger_entries
         (game_id, team_id, bar_id, source_claim_id, category, points)
       values ($1, $2, $3, $4, 'bar_share', 12)
       returning id`,
      [gameId, teamId, barId, claimId],
    );

    return {
      gameId,
      teamId,
      sessionId,
      barId,
      claimId,
      ledgerId: String(ledger.rows[0]?.id),
    };
  });
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(`delete from games where id = $1`, [fixture.gameId]);
    return undefined;
  });
}

async function asMember<T>(
  sessionId: string,
  fn: (tx: QueryRunner) => Promise<T>,
): Promise<T> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    await tx.query(`set local role anon`, []);
    await tx.query(`select set_config('bbb.session_id', $1, true)`, [
      sessionId,
    ]);
    return fn(tx);
  });
}

describe.skipIf(!DB_CONFIGURED)(
  "live map-and-claiming schema (Phase 1)",
  () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await createFixture();
    }, 30000);

    afterAll(async () => {
      if (fixture) {
        try {
          await deleteFixture(fixture);
        } catch {
          /* best-effort cleanup */
        }
      }
      await serverDb?.closeDb();
    }, 30000);

    it("rejects duplicate active claims, then permits revoke and reclaim", async () => {
      const { withTransaction } = await db();

      await expect(
        withTransaction((tx) =>
          tx.query(
            `insert into claims (game_id, team_id, bar_id)
             values ($1, $2, $3)`,
            [fixture.gameId, fixture.teamId, fixture.barId],
          ),
        ),
      ).rejects.toThrow();

      await withTransaction(async (tx) => {
        await tx.query(
          `update claims
              set revoked_at = now(), revoked_reason = 'integration-test'
            where id = $1`,
          [fixture.claimId],
        );
        return undefined;
      });

      const reclaimed = await withTransaction((tx) =>
        tx.query(
          `insert into claims (game_id, team_id, bar_id)
           values ($1, $2, $3)
           returning id, revoked_at`,
          [fixture.gameId, fixture.teamId, fixture.barId],
        ),
      );
      expect(reclaimed.rows).toHaveLength(1);
      expect(reclaimed.rows[0]?.revoked_at).toBeNull();
    });

    it("rejects updates and deletes against the append-only score ledger", async () => {
      const { withTransaction } = await db();

      await expect(
        withTransaction((tx) =>
          tx.query(
            `update score_ledger_entries set points = 99 where id = $1`,
            [fixture.ledgerId],
          ),
        ),
      ).rejects.toThrow();

      await expect(
        withTransaction((tx) =>
          tx.query(`delete from score_ledger_entries where id = $1`, [
            fixture.ledgerId,
          ]),
        ),
      ).rejects.toThrow();
    });

    it("allows member reads but denies client claim and ledger writes", async () => {
      const visible = await asMember(fixture.sessionId, async (tx) => {
        const claims = await tx.query(
          `select id from claims where game_id = $1`,
          [fixture.gameId],
        );
        const entries = await tx.query(
          `select id from score_ledger_entries where game_id = $1`,
          [fixture.gameId],
        );
        return { claims: claims.rows.length, entries: entries.rows.length };
      });

      expect(visible).toEqual({ claims: 2, entries: 1 });

      await expect(
        asMember(fixture.sessionId, (tx) =>
          tx.query(
            `update claims set revoked_reason = 'client-write' where id = $1`,
            [fixture.claimId],
          ),
        ),
      ).rejects.toThrow();

      await expect(
        asMember(fixture.sessionId, (tx) =>
          tx.query(
            `insert into score_ledger_entries
               (game_id, team_id, bar_id, category, points)
             values ($1, $2, $3, 'client-write', 1)`,
            [fixture.gameId, fixture.teamId, fixture.barId],
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
