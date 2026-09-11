/**
 * Task 18.2 — Live-channel isolation (ENVIRONMENT-DEPENDENT integration test).
 *
 * Proves the live counterpart of Property 14 (see
 * `lib/realtime/isolation.property.test.ts`): a client subscribed to game A
 * receives game A's events and **none** of game B's, exercised against a real
 * Supabase Realtime + Postgres instance rather than an in-memory model
 * (Req 6.3).
 *
 * How it works, end to end:
 *   1. Two distinct games A and B are created directly in Postgres over the
 *      privileged `SUPABASE_DB_URL` connection (`lib/db/server.ts`), which
 *      bypasses RLS for trusted setup.
 *   2. A Supabase browser-style realtime transport (`lib/realtime/index.ts`
 *      `subscribe` wired to the `@supabase/supabase-js` `postgres_changes`
 *      channel) subscribes to game A only. The `game_id=eq.A` channel filter is
 *      exactly what enforces per-game isolation on the wire (Req 6.3).
 *   3. `game_events` rows are then persisted into BOTH game A and game B (via
 *      `appendEvent` inside a transaction, the same path the demo mutation uses).
 *   4. Within a short window we assert the A-subscribed client received A's
 *      events (in ascending `seq`) and NEVER a game-B event.
 *
 * The subscribing client uses the **service-role** key so the subscription is
 * not blocked by RLS and the test stays self-contained (no per-game JWT/session
 * setup). Isolation here is therefore attributed to the channel's `game_id`
 * filter — the mechanism task 18.2 targets — not to RLS (RLS cross-game denial
 * is separately covered by task 18.5). The service key is server-only and never
 * shipped to the browser; this is test-only wiring.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED ENVIRONMENT (test SKIPS cleanly when any is unset)
 * ---------------------------------------------------------------------------
 *   NEXT_PUBLIC_SUPABASE_URL     Supabase project URL (realtime endpoint).
 *   SUPABASE_SERVICE_ROLE_KEY    Service-role key for the subscribing client
 *                                (bypasses RLS; server-only, test use only).
 *   SUPABASE_DB_URL              Direct Postgres connection string used to
 *                                create the two games and append events in a
 *                                transaction.
 *
 * Also honored (optional): NEXT_PUBLIC_SUPABASE_ANON_KEY is NOT required here
 * because the subscribing client uses the service-role key.
 *
 * RUN INSTRUCTIONS
 *   # against a local Supabase stack (supabase start) or a hosted project:
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   SUPABASE_DB_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
 *   npm test -- supabase/__tests__/integration/channelIsolation.integration.test.ts
 *
 * With none of these set, `npm test` skips this file (describe.skipIf), so the
 * default suite stays green with no live dependency.
 *
 * Validates: Requirements 6.3.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { appendEvent, type GameEvent } from "@/lib/events";
import { subscribe, type RealtimeSubscription } from "@/lib/realtime";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

// NOTE: `lib/db/server.ts` imports `server-only`, which only resolves inside the
// Next.js bundler. It is therefore loaded LAZILY (dynamic import, below) so that
// when this suite is skipped (no live env) the module is never evaluated and the
// default `npm test` run stays green outside a Next build.
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
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const DB_URL = process.env.SUPABASE_DB_URL?.trim();

const LIVE_ENV_CONFIGURED = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && DB_URL);

/** How long to wait for realtime delivery before asserting (ms). */
const DELIVERY_WINDOW_MS = 5_000;
/** Extra window to confirm NO game-B event leaks in after A's arrive (ms). */
const LEAK_WATCH_MS = 1_500;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until it is true or `timeoutMs` elapses. Returns whether it
 * became true within the window.
 */
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

/**
 * Insert a minimal, valid `games` row over the trusted DB connection and return
 * its id. Only the NOT NULL columns without defaults must be supplied:
 * `admin_session_id` and a unique `join_code`. Lifecycle defaults to 'lobby',
 * so `live_started_at` / `end_reason` stay null (satisfying the row checks).
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

/** Append one event to a game over the trusted DB connection. */
async function appendGameEvent(
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
// The test
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "Live-channel isolation (Task 18.2, Req 6.3)",
  () => {
    let client: SupabaseClient;
    let gameA: string;
    let gameB: string;
    let subscription: RealtimeSubscription | undefined;

    beforeAll(async () => {
      client = createClient(
        SUPABASE_URL as string,
        SERVICE_ROLE_KEY as string,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      );
      gameA = await createGame();
      gameB = await createGame();
    });

    afterAll(async () => {
      if (subscription) {
        await subscription.close();
      }
      // Best-effort cleanup; ignore failures so teardown never masks results.
      try {
        if (gameA) await deleteGame(gameA);
      } catch {
        /* ignore */
      }
      try {
        if (gameB) await deleteGame(gameB);
      } catch {
        /* ignore */
      }
      await client.removeAllChannels();
      if (serverDb) {
        await serverDb.closeDb();
      }
    });

    it(
      "delivers game A's events to an A-subscribed client and none of game B's",
      async () => {
        const received: GameEvent[] = [];

        // Subscribe to game A only. The transport opens a Supabase
        // postgres_changes channel filtered to game_id=eq.A (Req 6.3), and the
        // snapshot source reads A's prior events (empty here).
        subscription = await subscribe(gameA, {
          transport: supabaseRealtimeTransport(client),
          snapshotSource: supabaseSnapshotSource(client),
          handlers: {
            onEvent: (event) => {
              received.push(event);
            },
          },
        });

        // Give the realtime socket a moment to finish joining the channel
        // before writing, so we don't race the subscription setup.
        await delay(1_000);

        // Representative case: interleave writes to A and B. Two events into A,
        // two into B. Only A's should ever reach the client.
        await appendGameEvent(gameA, "isolation_a_1", { marker: "A1" });
        await appendGameEvent(gameB, "isolation_b_1", { marker: "B1" });
        await appendGameEvent(gameA, "isolation_a_2", { marker: "A2" });
        await appendGameEvent(gameB, "isolation_b_2", { marker: "B2" });

        // Wait until both of A's events have been delivered.
        const gotBothA = await waitFor(
          () => received.filter((e) => e.gameId === gameA).length >= 2,
          DELIVERY_WINDOW_MS,
        );
        expect(
          gotBothA,
          `expected both game A events within ${DELIVERY_WINDOW_MS}ms; received ` +
            `${received.length} event(s)`,
        ).toBe(true);

        // Watch a little longer to catch any late-arriving B leak.
        await delay(LEAK_WATCH_MS);

        // Every delivered event belongs to game A (channel isolation, Req 6.3).
        expect(received.every((e) => e.gameId === gameA)).toBe(true);
        // No game-B event ever reached the A-subscribed client.
        expect(received.some((e) => e.gameId === gameB)).toBe(false);
        // A's events arrived in ascending seq order, deduped by the client core.
        const aSeqs = received
          .filter((e) => e.gameId === gameA)
          .map((e) => e.seq);
        expect(aSeqs).toEqual([...aSeqs].sort((x, y) => x - y));
        expect(new Set(aSeqs).size).toBe(aSeqs.length);
      },
      // Generous timeout: channel join + write round-trips + watch windows.
      DELIVERY_WINDOW_MS + LEAK_WATCH_MS + 15_000,
    );
  },
);
