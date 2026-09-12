/**
 * Task 14.1 — Wireframe card-play Realtime delivery + channel isolation
 * (ENVIRONMENT-DEPENDENT integration test).
 *
 * These are the 1–3 representative integration examples the In-Game Landing
 * Wireframe design calls for: R7.2 (a committed `wireframe_card_played` event
 * reaches the target Team's subscribed clients within 5s) and R8.4 (the channel
 * delivers only the subscribed Game's events) exercise **external Supabase
 * infrastructure**, not our own logic, so they are represented as a small number
 * of live checks rather than exhaustive property tests.
 *
 * The foundation transport is **reused, not re-tested**: delivery rides the same
 * `subscribe()` (`lib/realtime`) wired to the project's browser adapter
 * (`lib/realtime/supabaseBrowser` — `supabaseRealtimeTransport` /
 * `supabaseSnapshotSource`), exactly as the Game_Board page does. The ordered
 * apply / dedup / per-game isolation *mechanism* is already property-tested in
 * the `lib/realtime` suites (referenced in place by task 11.2); here we only
 * confirm the one new `wireframe_card_played` event type flows over that same
 * backbone end to end.
 *
 * This mirrors the existing foundation integration suites
 * (`propagationLatency.integration.test.ts`, `channelIsolation.integration.test.ts`):
 *   - a real member-authenticated session (`createMemberSession`) subscribes so
 *     Realtime delivery passes RLS (migration 0006);
 *   - fixtures (teams, and the unrelated game B) are seeded over the trusted
 *     direct-Postgres connection (`lib/db/server.ts`), which bypasses RLS;
 *   - the `wireframe_card_played` event is appended via `appendEvent` inside a
 *     transaction (the same path the wireframe-card-play route uses), with the
 *     casting Team as actor and `{ castingTeamId, targetTeamId, cardId }` payload
 *     (matching `app/api/games/[gameId]/wireframe-card-play/route.ts`).
 *
 * ---------------------------------------------------------------------------
 * REQUIRED ENVIRONMENT (the whole suite SKIPS cleanly when any is unset)
 * ---------------------------------------------------------------------------
 *   NEXT_PUBLIC_SUPABASE_URL       Supabase project URL (member client + realtime).
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY  Anon key (member client, RLS-scoped).
 *   SUPABASE_SERVICE_ROLE_KEY      Service-role key (mint test user, seed/teardown).
 *   SUPABASE_DB_URL                Direct Postgres connection (seed teams / game B,
 *                                  append events in a transaction).
 *
 * The project's Postgres realtime must have `game_events` in the
 * `supabase_realtime` publication for INSERTs to propagate.
 *
 * RUN
 *   npm run test:integration -- \
 *     supabase/__tests__/integration/wireframeCardPropagation.integration.test.ts
 *
 * With no env configured, `describe.skipIf` makes this file a clean no-op so the
 * default `npm test` stays green with no live dependency.
 *
 * Validates: Requirements 7.2, 8.4
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { appendEvent, type GameEvent } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

import { createMemberSession, type MemberSession } from "./_session";

// `lib/db/server.ts` imports `server-only`, which only resolves in the Next.js
// bundler / the integration vitest config's alias. Load it LAZILY so that when
// this suite is skipped (no live env) the module is never evaluated and the
// default `npm test` run stays green.
type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

// ---------------------------------------------------------------------------
// Env gating: skip cleanly unless a live instance is configured.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const DB_URL = process.env.SUPABASE_DB_URL?.trim();

const LIVE_ENV_CONFIGURED = Boolean(
  SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY && DB_URL,
);

/** R7.2 delivery window: the target Team's clients receive it within 5s. */
const DELIVERY_WINDOW_MS = 5_000;
/** Extra window to confirm NO game-B event leaks in after A's arrive (R8.4). */
const LEAK_WATCH_MS = 1_500;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until true or `timeoutMs` elapses; returns the final value. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(stepMs);
  }
  return predicate();
}

/** Seed a Team row for a game over the trusted DB connection; returns its id. */
async function createTeam(
  gameId: string,
  name: string,
  color: string,
): Promise<string> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into teams (game_id, name, color)
       values ($1, $2, $3)
       returning id`,
      [gameId, name, color],
    );
    return String(rows[0]?.id);
  });
}

/**
 * Insert a minimal, valid `games` row over the trusted DB connection (an
 * unrelated game B for the isolation check) and return its id. Lifecycle
 * defaults to 'lobby'.
 */
async function createGame(): Promise<string> {
  const adminSessionId = `it-${randomUUID()}`;
  const joinCode = `it-${randomUUID()}`;
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into games (admin_session_id, join_code)
       values ($1, $2)
       returning id`,
      [adminSessionId, joinCode],
    );
    return String(rows[0]?.id);
  });
}

/**
 * Append exactly one `wireframe_card_played` event over the trusted DB
 * connection, with the casting Team as actor and the same payload shape the
 * wireframe-card-play route writes.
 */
async function appendWireframeCardPlayed(
  gameId: string,
  castingTeamId: string,
  targetTeamId: string,
  cardId: string,
): Promise<GameEvent> {
  const { withTransaction } = await db();
  return withTransaction((tx) =>
    appendEvent(tx, {
      gameId,
      type: GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
      actor: { kind: "team", teamId: castingTeamId },
      payload: { castingTeamId, targetTeamId, cardId },
    }),
  );
}

/** Append one arbitrary system event to a game (used as game-B noise). */
async function appendSystemEvent(
  gameId: string,
  type: string,
  payload: unknown,
): Promise<GameEvent> {
  const { withTransaction } = await db();
  return withTransaction((tx) =>
    appendEvent(tx, { gameId, type, actor: "system", payload }),
  );
}

/** Delete a game and its cascade-linked rows (best-effort test cleanup). */
async function deleteGame(gameId: string): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(`delete from games where id = $1`, [gameId]);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "Wireframe card-play Realtime delivery + isolation (Task 14.1, Req 7.2, 8.4)",
  () => {
    // Game A is owned by a real member (createMemberSession), so its
    // member-authenticated client can subscribe under RLS. Two teams (caster +
    // target) are seeded into it. Game B is an unrelated game for the isolation
    // check.
    let session: MemberSession;
    let gameA: string;
    let castingTeamId: string;
    let targetTeamId: string;
    let gameB: string;
    let subscription: RealtimeSubscription | undefined;

    beforeAll(async () => {
      session = await createMemberSession();
      gameA = session.gameId;
      castingTeamId = await createTeam(gameA, "Casters", "#ff3366");
      targetTeamId = await createTeam(gameA, "Targets", "#3366ff");
      gameB = await createGame();
    }, 30_000);

    afterAll(async () => {
      await subscription?.close().catch(() => undefined);
      // Best-effort cleanup; ignore failures so teardown never masks results.
      try {
        await session?.cleanup();
      } catch {
        /* ignore */
      }
      try {
        if (gameB) await deleteGame(gameB);
      } catch {
        /* ignore */
      }
      try {
        await session?.memberClient.removeAllChannels();
      } catch {
        /* ignore */
      }
      if (serverDb) {
        await serverDb.closeDb();
      }
    }, 30_000);

    it(
      "R7.2: a committed wireframe_card_played event reaches a subscriber within 5s",
      async () => {
        // A subscriber's onEvent captures the first wireframe_card_played event
        // and the wall-clock instant it was received, so we can measure
        // commit-to-receive latency against the 5s window.
        const received: GameEvent[] = [];
        const receivedCardPlay: { event: GameEvent | null; at: number } = {
          event: null,
          at: 0,
        };

        subscription = await subscribe(gameA, {
          transport: supabaseRealtimeTransport(session.memberClient),
          snapshotSource: supabaseSnapshotSource(session.memberClient),
          handlers: {
            onEvent: (event) => {
              received.push(event);
              if (
                receivedCardPlay.event === null &&
                event.eventType ===
                  GAME_BOARD_EVENT_TYPES.wireframeCardPlayed
              ) {
                receivedCardPlay.event = event;
                receivedCardPlay.at = Date.now();
              }
            },
          },
        });

        // Let the postgres_changes channel finish joining so the INSERT below is
        // observed live (bounded and short; latency is measured from commit).
        await delay(1_000);

        const cardId = `wf-${randomUUID()}`;
        const appended = await appendWireframeCardPlayed(
          gameA,
          castingTeamId,
          targetTeamId,
          cardId,
        );
        const committedAtMs = Date.parse(appended.createdAt);

        const gotIt = await waitFor(
          () => receivedCardPlay.event !== null,
          DELIVERY_WINDOW_MS + 2_000,
        );
        expect(gotIt).toBe(true);

        const event = receivedCardPlay.event as GameEvent;
        // It is the corresponding change: same game, the event we wrote, and it
        // carries the target Team so the client can raise a Targeted_Notification.
        expect(event.gameId).toBe(gameA);
        expect(event.seq).toBe(appended.seq);
        expect(event.eventType).toBe(
          GAME_BOARD_EVENT_TYPES.wireframeCardPlayed,
        );
        expect(event.actorTeamId).toBe(castingTeamId);
        expect(event.payload).toMatchObject({
          castingTeamId,
          targetTeamId,
          cardId,
        });

        // Commit-to-receive latency within the 5s window (R7.2), measured from
        // the row's committed created_at to the instant onEvent fired.
        const latencyMs = receivedCardPlay.at - committedAtMs;
        expect(latencyMs).toBeLessThan(DELIVERY_WINDOW_MS);
      },
      DELIVERY_WINDOW_MS + 20_000,
    );

    it(
      "R8.4: the channel delivers only the subscribed Game's events (game A, not game B)",
      async () => {
        // Reuse the game-A subscription opened by the first test. Snapshot has
        // already caught up A's prior event; watch for new deliveries here.
        expect(subscription).toBeDefined();
        const received: GameEvent[] = [];

        // Re-open a fresh subscription on a distinct client so this test stands
        // on its own (distinct realtime channel; the foundation keys channels by
        // client). Close the shared one first to avoid double-counting.
        await subscription?.close().catch(() => undefined);
        const client = session.makeMemberClient();
        subscription = await subscribe(gameA, {
          transport: supabaseRealtimeTransport(client),
          snapshotSource: supabaseSnapshotSource(client),
          handlers: {
            onEvent: (event) => {
              received.push(event);
            },
          },
        });

        await delay(1_000);
        const baseline = received.length;

        // Interleave writes: a wireframe_card_played into A, unrelated events
        // into B. Only A's should ever reach the A-subscribed client.
        await appendWireframeCardPlayed(
          gameA,
          castingTeamId,
          targetTeamId,
          `wf-${randomUUID()}`,
        );
        await appendSystemEvent(gameB, "isolation_b_1", { marker: "B1" });
        await appendSystemEvent(gameB, "isolation_b_2", { marker: "B2" });

        // Wait until the new game-A event has been delivered.
        const gotNewA = await waitFor(
          () => received.filter((e) => e.gameId === gameA).length > baseline,
          DELIVERY_WINDOW_MS,
        );
        expect(gotNewA).toBe(true);

        // Watch a little longer to catch any late-arriving game-B leak.
        await delay(LEAK_WATCH_MS);

        // Every delivered event belongs to game A; no game-B event ever arrived.
        expect(received.every((e) => e.gameId === gameA)).toBe(true);
        expect(received.some((e) => e.gameId === gameB)).toBe(false);
      },
      DELIVERY_WINDOW_MS + LEAK_WATCH_MS + 20_000,
    );
  },
);
