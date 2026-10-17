/**
 * Brawl Deck Architecture — Task 3: live deck-persistence round-trip.
 *
 * Gated on SUPABASE_DB_URL. Drives the real persistence helper
 * (`lib/cards/persistence.ts`) through the actual `withTransaction` against
 * Postgres, so the committed 0009 + 0011 schema — the deck_state column, the
 * widened lifecycle check, the pending_bar_id FK, and the card_draws
 * once-per-bar unique — is exercised end to end.
 *
 * Each test seeds an isolated live game and cleans it up by cascade. The
 * hermetic `lib/cards/persistence.test.ts` covers the mapping logic in detail;
 * this suite proves the mapping actually satisfies the live constraints and that
 * state survives a real reload.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

type Persistence = typeof import("@/lib/cards/persistence");
let persistence: Persistence | undefined;
async function persist(): Promise<Persistence> {
  persistence ??= await import("@/lib/cards/persistence");
  return persistence;
}

type Deck = typeof import("@/lib/cards/deck");
let deck: Deck | undefined;
async function engine(): Promise<Deck> {
  deck ??= await import("@/lib/cards/deck");
  return deck;
}

interface Fixture {
  readonly gameId: string;
  readonly teamId: string;
  readonly barAId: string;
  readonly barBId: string;
}

const createdGameIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const adminSession = `it-deck-admin-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now())
       returning id`,
      [adminSession, `ITDK${randomUUID().slice(0, 8)}`],
    );
    const gameId = String(game.rows[0]?.id);

    const team = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, 'Deck Team', '#e6194b')
       returning id`,
      [gameId],
    );
    const teamId = String(team.rows[0]?.id);

    const barA = await tx.query(
      `insert into bars (game_id, name) values ($1, 'Deck Bar A') returning id`,
      [gameId],
    );
    const barB = await tx.query(
      `insert into bars (game_id, name) values ($1, 'Deck Bar B') returning id`,
      [gameId],
    );

    return {
      gameId,
      teamId,
      barAId: String(barA.rows[0]?.id),
      barBId: String(barB.rows[0]?.id),
    };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
}

afterAll(async () => {
  if (!serverDb) return;
  const { withTransaction, closeDb } = serverDb;
  for (const gameId of createdGameIds) {
    try {
      await withTransaction(async (tx) => {
        await tx.query(`delete from games where id = $1`, [gameId]);
        return undefined;
      });
    } catch {
      /* best-effort cleanup */
    }
  }
  await closeDb();
});

// Each test performs many sequential round-trips to the remote Postgres (the
// first seeds the full 23-card roster), well over the default 5s per-test
// budget against the shared pooler. Give the DB-heavy flows a generous timeout.
const DB_TEST_TIMEOUT_MS = 30_000;

describe.skipIf(!DB_CONFIGURED)("live deck persistence (R4.1, R4.2)", () => {
  it(
    "seeds, draws, keeps, and plays with state surviving reloads",
    async () => {
      const fixture = await createFixture();
      const { withTransaction } = await db();
      const { applyDeckTransition, loadDeckState } = await persist();
      const { drawForBar, keepCard, playCard, seedDeck } = await engine();
      const ctx = { gameId: fixture.gameId, teamId: fixture.teamId };

      // First touch: a draw seeds the full roster durably and produces 2 pending.
      const drawResult = await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "draw",
          transition: (state) => drawForBar(state, fixture.barAId),
          barId: fixture.barAId,
        }),
      );
      expect(drawResult.ok).toBe(true);
      if (!drawResult.ok) return;

      // Reload from durable rows: the full 23-card deck is present, 2 pending.
      const afterDraw = await withTransaction((tx) => loadDeckState(tx, ctx));
      expect(afterDraw.cards).toHaveLength(
        seedDeck(fixture.teamId).cards.length,
      );
      expect(afterDraw.cards.filter((c) => c.state === "pending")).toHaveLength(
        2,
      );
      expect(afterDraw.pendingBarId).toBe(fixture.barAId);
      expect(afterDraw.drawnBarIds).toEqual([fixture.barAId]);

      // Keep one of the pending cards; the other is discarded.
      const keptId = drawResult.cardIds?.[0] as string;
      const keepResult = await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "keep",
          transition: (state) => keepCard(state, keptId),
        }),
      );
      expect(keepResult.ok).toBe(true);

      const afterKeep = await withTransaction((tx) => loadDeckState(tx, ctx));
      expect(afterKeep.cards.find((c) => c.id === keptId)?.state).toBe("hand");
      expect(afterKeep.cards.filter((c) => c.state === "pending")).toHaveLength(
        0,
      );
      expect(
        afterKeep.cards.filter((c) => c.state === "discarded"),
      ).toHaveLength(1);
      expect(afterKeep.pendingBarId).toBeNull();

      // Play the kept card with a target payload.
      const playResult = await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "play",
          transition: (state) => playCard(state, keptId),
          eventExtra: { targetTeamId: fixture.teamId },
        }),
      );
      expect(playResult.ok).toBe(true);

      const afterPlay = await withTransaction((tx) => loadDeckState(tx, ctx));
      expect(afterPlay.cards.find((c) => c.id === keptId)?.state).toBe(
        "played",
      );

      // The event log recorded one of each transition, in order.
      const events = await withTransaction((tx) =>
        tx.query(
          `select event_type from game_events
          where game_id = $1
            and event_type in ('cards_drawn','card_kept','card_played')
          order by seq`,
          [fixture.gameId],
        ),
      );
      const types = events.rows.map((r) => String(r.event_type));
      expect(types).toEqual(["cards_drawn", "card_kept", "card_played"]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    "re-drawing an already-drawn bar is rejected after a reload (R1.4)",
    async () => {
      const fixture = await createFixture();
      const { withTransaction } = await db();
      const { applyDeckTransition, loadDeckState } = await persist();
      const { drawForBar, keepCard } = await engine();
      const ctx = { gameId: fixture.gameId, teamId: fixture.teamId };

      await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "draw",
          transition: (state) => drawForBar(state, fixture.barAId),
          barId: fixture.barAId,
        }),
      );
      // Resolve the pending draw so a subsequent draw is not pending-blocked.
      const pending = await withTransaction((tx) => loadDeckState(tx, ctx));
      const keptId = pending.cards.find((c) => c.state === "pending")
        ?.id as string;
      await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "keep",
          transition: (state) => keepCard(state, keptId),
        }),
      );

      // A fresh load still knows bar A was drawn -> re-draw rejected.
      const reloaded = await withTransaction((tx) => loadDeckState(tx, ctx));
      expect(reloaded.drawnBarIds).toContain(fixture.barAId);
      const redraw = drawForBar(reloaded, fixture.barAId);
      expect(redraw.ok).toBe(false);

      // A different bar can still be drawn.
      const other = await withTransaction((tx) =>
        applyDeckTransition(tx, {
          ctx,
          kind: "draw",
          transition: (state) => drawForBar(state, fixture.barBId),
          barId: fixture.barBId,
        }),
      );
      expect(other.ok).toBe(true);
    },
    DB_TEST_TIMEOUT_MS,
  );
});
