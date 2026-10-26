/**
 * Live schema checks for migration 0013 (card-behavior).
 *
 * This suite is gated on SUPABASE_DB_URL and uses the direct database
 * connection (`lib/db/server`) so it can exercise the new card-behavior tables,
 * their check constraints, and the two partial unique indexes directly against a
 * live Supabase project. It creates and removes one throwaway game.
 *
 * It verifies:
 *   - migration 0013 applied (the new tables accept well-formed rows);
 *   - `card_effect_awards_one_live` rejects a second un-reversed award per
 *     (effect, team) and permits one after the first is reversed;
 *   - `game_events_effect_transition_once` rejects a duplicate
 *     effect_activated / effect_expired for the same effectId;
 *   - the `card_effects` check constraints (window_valid, cancel_fields) and
 *     `fairest_offers_subject` reject invalid rows.
 *
 * Runs only under `npm run test:integration` (which loads .env.local). The
 * default hermetic `npm test` sees SUPABASE_DB_URL undefined and skips.
 *
 * Requirements covered: 13.6, 20.4, 24.4.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

interface Fixture {
  readonly gameId: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string;
  readonly sessionId: string;
  readonly barId: string;
  readonly claimId: string;
  /** Throwaway catalog row (no game_id, so not cascade-deleted with the game). */
  readonly definitionId: string;
  readonly playId: string;
  readonly challengeId: string;
  /** A live score-protection effect, used for award and transition checks. */
  readonly effectId: string;
  readonly ledgerId: string;
  readonly reversalLedgerId: string;
}

/**
 * Seed one game with two teams, a bar, a claim, a card_plays record, and one
 * each of the new engine rows (card_challenges, card_effects, fairest_offers,
 * card_effect_awards). Every insert here is a VALID row, so a successful seed is
 * itself the "migration 0013 applied / well-formed rows accepted" assertion.
 */
async function createFixture(): Promise<Fixture> {
  const { withTransaction } = await db();
  const sessionId = `it-cardbehavior-${randomUUID()}`;

  return withTransaction(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now())
       returning id`,
      [sessionId, `CB${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    const gameId = String(game.rows[0]?.id);

    const caster = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'CB Caster', '#123456')
       returning id`,
      [gameId],
    );
    const casterTeamId = String(caster.rows[0]?.id);

    const target = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'CB Target', '#654321')
       returning id`,
      [gameId],
    );
    const targetTeamId = String(target.rows[0]?.id);

    await tx.query(
      `insert into players (team_id, game_id, session_id, display_name)
       values ($1, $2, $3, 'CB Player')`,
      [casterTeamId, gameId, sessionId],
    );

    const bar = await tx.query(
      `insert into bars (game_id, name)
       values ($1, 'CB Bar')
       returning id`,
      [gameId],
    );
    const barId = String(bar.rows[0]?.id);

    const claim = await tx.query(
      `insert into claims (game_id, team_id, bar_id)
       values ($1, $2, $3)
       returning id`,
      [gameId, casterTeamId, barId],
    );
    const claimId = String(claim.rows[0]?.id);

    // card_plays needs a card_instance, which needs a card_definition. Insert a
    // throwaway catalog row + instance so the fixture is self-contained and does
    // not depend on the seeded catalog being present.
    const definition = await tx.query(
      `insert into card_definitions
         (slug, name, card_type, requires_target, effect_summary)
       values ($1, 'CB Fixture Card', 'economy_boost', false, 'fixture')
       returning id`,
      [`cb-fixture-${randomUUID()}`],
    );
    const definitionId = String(definition.rows[0]?.id);

    const instance = await tx.query(
      `insert into card_instances (game_id, definition_id, holder_team_id, state)
       values ($1, $2, $3, 'played')
       returning id`,
      [gameId, definitionId, casterTeamId],
    );
    const instanceId = String(instance.rows[0]?.id);

    // card_plays gained slug / target_bar_* / params in 0013.
    const play = await tx.query(
      `insert into card_plays
         (game_id, card_instance_id, casting_team_id, target_team_id, slug, params)
       values ($1, $2, $3, $4, 'happy-hour', '{"announcedBarKey":"cb-bar"}'::jsonb)
       returning id`,
      [gameId, instanceId, casterTeamId, targetTeamId],
    );
    const playId = String(play.rows[0]?.id);

    // A valid open challenge.
    const challenge = await tx.query(
      `insert into card_challenges
         (game_id, source_play_id, slug, caster_team_id, target_team_id, created_at)
       values ($1, $2, 'go-piss-girl', $3, $4, now())
       returning id`,
      [gameId, playId, casterTeamId, targetTeamId],
    );
    const challengeId = String(challenge.rows[0]?.id);

    // A valid, live score-protection effect (open-ended window).
    const effect = await tx.query(
      `insert into card_effects
         (game_id, source_play_id, slug, kind, owner_team_id, starts_at, created_at)
       values ($1, $2, 'happy-hour', 'bonus_window', $3, now(), now())
       returning id`,
      [gameId, playId, casterTeamId],
    );
    const effectId = String(effect.rows[0]?.id);

    // A valid fairest_offers row: exactly one subject (challenge_id) set.
    await tx.query(
      `insert into fairest_offers
         (game_id, source_play_id, slug, holder_team_id,
          original_caster_team_id, challenge_id, created_at)
       values ($1, $2, 'fairest-of-them-all', $3, $4, $5, now())`,
      [gameId, playId, targetTeamId, casterTeamId, challengeId],
    );

    // Two ledger entries: one applied, one reserved as a reversal partner.
    const ledger = await tx.query(
      `insert into score_ledger_entries
         (game_id, team_id, bar_id, source_claim_id, category, points, source_effect_id)
       values ($1, $2, $3, $4, 'happy_hour_bonus', 5, $5)
       returning id`,
      [gameId, casterTeamId, barId, claimId, effectId],
    );
    const ledgerId = String(ledger.rows[0]?.id);

    const reversal = await tx.query(
      `insert into score_ledger_entries
         (game_id, team_id, bar_id, source_claim_id, category, points, source_effect_id)
       values ($1, $2, $3, $4, 'happy_hour_bonus', -5, $5)
       returning id`,
      [gameId, casterTeamId, barId, claimId, effectId],
    );
    const reversalLedgerId = String(reversal.rows[0]?.id);

    return {
      gameId,
      casterTeamId,
      targetTeamId,
      sessionId,
      barId,
      claimId,
      definitionId,
      playId,
      challengeId,
      effectId,
      ledgerId,
      reversalLedgerId,
    };
  });
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    // Deleting the game cascades to teams/players/bars/claims/card_instances/
    // card_plays and every new 0013 table. The throwaway card_definitions row
    // has no game_id, so remove it explicitly after the game (and its instances)
    // are gone.
    await tx.query(`delete from games where id = $1`, [fixture.gameId]);
    await tx.query(`delete from card_definitions where id = $1`, [
      fixture.definitionId,
    ]);
    return undefined;
  });
}

describe.skipIf(!DB_CONFIGURED)("live card-behavior schema (0013)", () => {
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

  it("accepts a first live award but rejects a second un-reversed one per (effect, team)", async () => {
    const { withTransaction } = await db();

    // First live (un-reversed) award: accepted.
    const first = await withTransaction((tx) =>
      tx.query(
        `insert into card_effect_awards
           (game_id, effect_id, team_id, kind, claim_id, ledger_entry_id, created_at)
         values ($1, $2, $3, 'happy_hour_bonus', $4, $5, now())
         returning id`,
        [
          fixture.gameId,
          fixture.effectId,
          fixture.casterTeamId,
          fixture.claimId,
          fixture.ledgerId,
        ],
      ),
    );
    expect(first.rows).toHaveLength(1);

    // Second un-reversed award for the same (effect, team): rejected by the
    // card_effect_awards_one_live partial unique index.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into card_effect_awards
             (game_id, effect_id, team_id, kind, claim_id, ledger_entry_id, created_at)
           values ($1, $2, $3, 'happy_hour_bonus', $4, $5, now())`,
          [
            fixture.gameId,
            fixture.effectId,
            fixture.casterTeamId,
            fixture.claimId,
            fixture.ledgerId,
          ],
        ),
      ),
    ).rejects.toThrow();

    // Reverse the first award, then a new live award is permitted again.
    await withTransaction(async (tx) => {
      await tx.query(
        `update card_effect_awards
            set reversed_at = now(), reversal_ledger_entry_id = $2
          where id = $1`,
        [String(first.rows[0]?.id), fixture.reversalLedgerId],
      );
      return undefined;
    });

    const third = await withTransaction((tx) =>
      tx.query(
        `insert into card_effect_awards
           (game_id, effect_id, team_id, kind, claim_id, ledger_entry_id, created_at)
         values ($1, $2, $3, 'happy_hour_bonus', $4, $5, now())
         returning id, reversed_at`,
        [
          fixture.gameId,
          fixture.effectId,
          fixture.casterTeamId,
          fixture.claimId,
          fixture.ledgerId,
        ],
      ),
    );
    expect(third.rows).toHaveLength(1);
    expect(third.rows[0]?.reversed_at).toBeNull();
  });

  it("rejects a duplicate effect-transition event for the same effectId", async () => {
    const { withTransaction } = await db();

    // Reserve a seq above anything the fixture inserted implicitly.
    async function appendTransition(seq: number, eventType: string) {
      return withTransaction((tx) =>
        tx.query(
          `insert into game_events (game_id, seq, event_type, actor_kind, payload)
           values ($1, $2, $3, 'system', $4::jsonb)`,
          [
            fixture.gameId,
            seq,
            eventType,
            JSON.stringify({ effectId: fixture.effectId }),
          ],
        ),
      );
    }

    // First effect_activated for this effect: accepted.
    await appendTransition(9001, "effect_activated");

    // Duplicate effect_activated for the SAME effectId: rejected by
    // game_events_effect_transition_once.
    await expect(appendTransition(9002, "effect_activated")).rejects.toThrow();

    // A different transition type for the same effect is still allowed
    // (the index is scoped per event_type).
    await expect(
      appendTransition(9003, "effect_expired"),
    ).resolves.toBeDefined();

    // ...but a duplicate of THAT one is rejected too.
    await expect(appendTransition(9004, "effect_expired")).rejects.toThrow();
  });

  it("rejects card_effects with a non-positive window (window_valid)", async () => {
    const { withTransaction } = await db();

    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into card_effects
             (game_id, source_play_id, slug, kind, starts_at, ends_at, created_at)
           values ($1, $2, 'crop-dusting', 'bar_lock', now(), now(), now())`,
          [fixture.gameId, fixture.playId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects card_effects whose cancel fields disagree (cancel_fields)", async () => {
    const { withTransaction } = await db();

    // cancelled_at set but cancel_reason null: rejected.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into card_effects
             (game_id, source_play_id, slug, kind, starts_at, cancelled_at, created_at)
           values ($1, $2, 'crop-dusting', 'bar_lock', now(), now(), now())`,
          [fixture.gameId, fixture.playId],
        ),
      ),
    ).rejects.toThrow();

    // cancel_reason set but cancelled_at null: also rejected.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into card_effects
             (game_id, source_play_id, slug, kind, starts_at, cancel_reason, created_at)
           values ($1, $2, 'crop-dusting', 'bar_lock', now(), 'host', now())`,
          [fixture.gameId, fixture.playId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects fairest_offers with neither or both subjects (fairest_offers_subject)", async () => {
    const { withTransaction } = await db();

    // Neither challenge_id nor restriction_effect_id set: rejected.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into fairest_offers
             (game_id, source_play_id, slug, holder_team_id,
              original_caster_team_id, created_at)
           values ($1, $2, 'fairest-of-them-all', $3, $4, now())`,
          [
            fixture.gameId,
            fixture.playId,
            fixture.targetTeamId,
            fixture.casterTeamId,
          ],
        ),
      ),
    ).rejects.toThrow();

    // Both subjects set: also rejected.
    await expect(
      withTransaction((tx) =>
        tx.query(
          `insert into fairest_offers
             (game_id, source_play_id, slug, holder_team_id,
              original_caster_team_id, challenge_id, restriction_effect_id, created_at)
           values ($1, $2, 'fairest-of-them-all', $3, $4, $5, $6, now())`,
          [
            fixture.gameId,
            fixture.playId,
            fixture.targetTeamId,
            fixture.casterTeamId,
            fixture.challengeId,
            fixture.effectId,
          ],
        ),
      ),
    ).rejects.toThrow();
  });
});
