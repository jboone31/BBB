/**
 * Live delivery within the Delivery_Bound — integration (card-behavior Task 10.9).
 *
 * Runs only under `npm run test:integration` (which loads .env.local). It needs
 * SUPABASE_DB_URL (server routes + fixture writes) and the three Supabase vars
 * (member-authenticated, RLS-scoped reads and Realtime). The default hermetic
 * `npm test` sees them unset and skips the whole suite (Requirement 24.4).
 *
 * Requirement 23.8 / 24.6: a committed event for a live game reaches every
 * connected Board_Projection within the Delivery_Bound — one Recheck_Interval
 * (15 s) plus fetch latency and clock-offset error. This suite drives a
 * Target_Team member's Board_Projection the way `app/games/[gameId]/board/page.tsx`
 * does, in Node:
 *
 *   - the initial snapshot folds through `foldGameBoardEvents`;
 *   - every event source (Realtime `onEvent` and the recheck fetch) funnels
 *     through one ordered gate (`applyInOrder`) into `applyGameBoardEvent`, and
 *     each applied event is noted on the `RecheckController`;
 *   - a `RecheckController` (lib/realtime/recheck.ts) runs while the projection
 *     is live, fetching through the RLS-scoped `supabaseSnapshotSource`.
 *
 * The event committed is a real `/cards/play` of a team-targeting challenge by
 * the casting team at the member's team (the Target_Team). Two scenarios:
 *
 *   1. Realtime healthy: the play reaches the projection within 15 s.
 *   2. Realtime silently drops every new event: only the recheck can deliver,
 *      and it still lands within 15 s.
 *
 * Each attempt commits a fresh challenge play and waits one Recheck_Interval for
 * it; the assertion is retried up to 3 times before failing, absorbing the fetch
 * latency and clock-offset error the Delivery_Bound allows (design.md "Recheck
 * behind Realtime"). The window is measured from just before the play request,
 * so it is no looser than measuring from the commit.
 *
 * Requirements: 23.8, 24.4, 24.6.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { GameEvent } from "@/lib/events";
import {
  applyGameBoardEvent,
  foldGameBoardEvents,
  initialGameBoardView,
  type GameBoardView,
} from "@/lib/gameboard/events";
import {
  applyInOrder,
  initialOrderedApplyState,
  subscribe,
  type OrderedApplyState,
  type RealtimeSubscription,
} from "@/lib/realtime";
import { RECHECK_INTERVAL_MS, RecheckController } from "@/lib/realtime/recheck";
import {
  supabaseRealtimeTransport,
  supabaseSnapshotSource,
} from "@/lib/realtime/supabaseBrowser";

import { createMemberSession, type MemberSession } from "./_session";

const LIVE_ENV_CONFIGURED =
  isNonEmpty(process.env.SUPABASE_DB_URL) &&
  isNonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  isNonEmpty(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
  isNonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY);

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const SESSION_HEADER = "x-bbb-session-id";
/** Up to 3 assertion attempts before failing (Req 24.6). */
const MAX_ATTEMPTS = 3;
/**
 * Pause before each commit so the channel is subscribed and the commit is not
 * phase-locked to a recheck fire that just happened (the quiet window must be
 * anchored at or before the commit for the 15 s bound to apply).
 */
const SETTLE_MS = 2_000;
/** Three distinct team-targeting challenges (same-name-once rule, Req 3.3). */
const CHALLENGE_SLUGS = ["go-piss-girl", "wired", "dirty-bird"] as const;
const TEST_TIMEOUT_MS =
  MAX_ATTEMPTS * (RECHECK_INTERVAL_MS + SETTLE_MS + 10_000) + 30_000;

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

interface Fixture {
  readonly session: MemberSession;
  readonly gameId: string;
  /** The casting team (a header-only session player). */
  readonly casterTeamId: string;
  readonly casterSession: string;
  /** The Target_Team: the member's own team. */
  readonly targetTeamId: string;
}

const fixtures: Fixture[] = [];

/**
 * Seed a live game whose Target_Team member is a real Supabase Auth user (so its
 * reads and Realtime pass RLS), plus a casting team, start/finish bars, and the
 * `game_started` event so the folded projection is live.
 */
async function createFixture(): Promise<Fixture> {
  const session = await createMemberSession({ withPlayer: true });
  const gameId = session.gameId;
  const casterSession = `it-recheck-caster-${randomUUID()}`;
  const { withTransaction } = await db();
  const { appendEvent } = await import("@/lib/events");

  const ids = await withTransaction(async (tx) => {
    const target = await tx.query(
      `select team_id from players where game_id = $1 and session_id = $2`,
      [gameId, session.sessionId],
    );
    const targetTeamId = String(target.rows[0]?.team_id);

    const caster = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Recheck Caster', '#e6194b') returning id`,
      [gameId],
    );
    const casterTeamId = String(caster.rows[0]?.id);
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Recheck caster')`,
      [gameId, casterTeamId, casterSession],
    );

    const bars: Record<string, string> = {};
    for (const [key, name] of [
      ["start", "Recheck Start"],
      ["finish", "Recheck Finish"],
    ] as const) {
      const bar = await tx.query(
        `insert into bars (game_id, name) values ($1, $2) returning id`,
        [gameId, name],
      );
      bars[key] = String(bar.rows[0]?.id);
    }
    await tx.query(
      `update games
          set lifecycle = 'live', live_started_at = now(),
              start_bar_id = $2, finish_bar_id = $3
        where id = $1`,
      [gameId, bars.start, bars.finish],
    );
    await appendEvent(tx, {
      gameId,
      type: "game_started",
      actor: { kind: "admin" },
      payload: {},
    });
    return { targetTeamId, casterTeamId };
  });

  const fixture: Fixture = { session, gameId, casterSession, ...ids };
  fixtures.push(fixture);
  return fixture;
}

/** Remove a fixture game (append-only triggers disabled) and its auth user. */
async function cleanupFixture(fixture: Fixture): Promise<void> {
  const { withTransaction } = await db();
  try {
    await withTransaction(async (tx) => {
      await tx.query(
        `alter table game_events disable trigger game_events_no_update_delete`,
      );
      await tx.query(
        `alter table score_ledger_entries disable trigger score_ledger_entries_no_update_delete`,
      );
      await tx.query(`delete from games where id = $1`, [fixture.gameId]);
      await tx.query(
        `alter table score_ledger_entries enable trigger score_ledger_entries_no_update_delete`,
      );
      await tx.query(
        `alter table game_events enable trigger game_events_no_update_delete`,
      );
      return undefined;
    });
  } finally {
    await fixture.session.cleanup();
  }
}

/**
 * A Target_Team member's board, wired like the board page: snapshot fold,
 * one ordered apply gate for Realtime and recheck events, and a
 * `RecheckController` running while the projection is live.
 */
interface Board {
  view(): GameBoardView;
  /** Count of new events Realtime delivered (and were not dropped). */
  realtimeDelivered(): number;
  close(): Promise<void>;
}

async function openBoard(
  fixture: Fixture,
  options: { readonly dropRealtimeAfterSeq?: number } = {},
): Promise<Board> {
  const { gameId } = fixture;
  const client = fixture.session.makeMemberClient();
  const transport = supabaseRealtimeTransport(client);
  const snapshotSource = supabaseSnapshotSource(client);

  let view = initialGameBoardView(gameId);
  let order: OrderedApplyState = initialOrderedApplyState();
  let recheck: RecheckController | null = null;
  let realtimeDelivered = 0;

  // Same gate as the board page's `foldEvent`.
  const ingest = (event: GameEvent): void => {
    if (event.gameId !== gameId) return;
    if (event.seq > order.lastSeenSequence + 1) {
      recheck?.noteEvent(event);
    }
    const result = applyInOrder(order, event);
    order = result.state;
    if (result.applied.length === 0) return;
    view = result.applied.reduce(applyGameBoardEvent, view);
    for (const applied of result.applied) {
      recheck?.noteEvent(applied);
    }
  };

  const sub: RealtimeSubscription = await subscribe(gameId, {
    transport,
    snapshotSource,
    handlers: {
      onEvent: (event) => {
        // Simulate Realtime silently dropping postgres_changes messages.
        const drop =
          options.dropRealtimeAfterSeq !== undefined &&
          event.seq > options.dropRealtimeAfterSeq;
        if (drop) return;
        realtimeDelivered += 1;
        ingest(event);
      },
      onSnapshotEvents: (events) => {
        view = foldGameBoardEvents(gameId, events);
        if (view.lastSeenSequence > order.lastSeenSequence) {
          order = initialOrderedApplyState(view.lastSeenSequence);
        }
      },
    },
  });

  expect(view.lifecycle, "projection must be live to arm the recheck").toBe(
    "live",
  );
  recheck = new RecheckController(gameId, {
    fetchEventsAfter: (id, afterSeq) =>
      snapshotSource.fetchEventsAfter(id, afterSeq),
    apply: (events) => {
      for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
        ingest(event);
      }
    },
    lastSeq: () => order.lastSeenSequence,
    isLive: () => view.lifecycle === "live",
  });
  recheck.start();

  return {
    view: () => view,
    realtimeDelivered: () => realtimeDelivered,
    close: async () => {
      recheck?.stop();
      await sub.close().catch(() => undefined);
      await client.removeAllChannels().catch(() => undefined);
    },
  };
}

/** Inject `slug` into the caster's hand and play it at the Target_Team. */
async function commitChallengePlay(
  fixture: Fixture,
  slug: (typeof CHALLENGE_SLUGS)[number],
): Promise<number> {
  const { withTransaction } = await db();
  const { injectCardToHand } = await import("@/lib/cards/persistence");
  const injected = await withTransaction((tx) =>
    injectCardToHand(
      tx,
      { gameId: fixture.gameId, teamId: fixture.casterTeamId },
      slug,
    ),
  );
  if (!injected.ok)
    throw new Error(`inject ${slug} failed: ${injected.reason}`);

  const { POST } = await import("@/app/api/games/[gameId]/cards/play/route");
  const response = await POST(
    new Request(`http://localhost/api/games/${fixture.gameId}/cards/play`, {
      method: "POST",
      headers: {
        [SESSION_HEADER]: fixture.casterSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        cardId: injected.cardId,
        targetTeamId: fixture.targetTeamId,
      }),
    }),
    { params: Promise.resolve({ gameId: fixture.gameId }) },
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200 || typeof body.seq !== "number") {
    throw new Error(
      `play ${slug} failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body.seq;
}

/** Whether the projection includes the targeted play committed at `seq`. */
function includesPlay(
  view: GameBoardView,
  seq: number,
  targetTeamId: string,
): boolean {
  return Object.values(view.cardBehavior.plays).some(
    (play) => play.seq === seq && play.targetTeamId === targetTeamId,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/**
 * Commit a fresh targeted play and wait one Recheck_Interval for the Target_Team
 * member's projection to include it; retry up to {@link MAX_ATTEMPTS} times.
 */
async function assertDeliveredWithinBound(
  fixture: Fixture,
  board: Board,
): Promise<{ attempt: number; elapsedMs: number }> {
  const misses: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await sleep(SETTLE_MS);
    const startedAt = Date.now();
    const seq = await commitChallengePlay(
      fixture,
      CHALLENGE_SLUGS[attempt - 1]!,
    );
    const delivered = await waitFor(
      () => includesPlay(board.view(), seq, fixture.targetTeamId),
      RECHECK_INTERVAL_MS - (Date.now() - startedAt),
    );
    const elapsedMs = Date.now() - startedAt;
    if (delivered && elapsedMs <= RECHECK_INTERVAL_MS) {
      return { attempt, elapsedMs };
    }
    misses.push(
      `attempt ${attempt}: seq ${seq} not in projection after ${elapsedMs}ms (watermark ${board.view().lastSeenSequence})`,
    );
  }
  throw new Error(
    `event not delivered within ${RECHECK_INTERVAL_MS}ms in ${MAX_ATTEMPTS} attempts:\n${misses.join("\n")}`,
  );
}

describe.skipIf(!LIVE_ENV_CONFIGURED)(
  "committed events reach the Target_Team member's projection within the Delivery_Bound (R23.8, R24.6)",
  () => {
    let boards: Board[] = [];

    beforeAll(async () => {
      await db();
    });

    afterAll(async () => {
      for (const board of boards) await board.close();
      boards = [];
      try {
        for (const fixture of fixtures) {
          await cleanupFixture(fixture).catch(() => undefined);
        }
      } finally {
        await serverDb?.closeDb();
      }
    }, 60_000);

    it(
      "delivers a targeted play via Realtime plus the recheck within one Recheck_Interval",
      async () => {
        const fixture = await createFixture();
        const board = await openBoard(fixture);
        boards.push(board);

        const { elapsedMs } = await assertDeliveredWithinBound(fixture, board);
        expect(elapsedMs).toBeLessThanOrEqual(RECHECK_INTERVAL_MS);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "delivers a targeted play through the recheck alone when Realtime drops it",
      async () => {
        const fixture = await createFixture();
        // Drop every Realtime message past the snapshot: only the recheck can
        // deliver, exercising the quiet-window path of the Delivery_Bound.
        const board = await openBoard(fixture, { dropRealtimeAfterSeq: 0 });
        boards.push(board);

        const { elapsedMs } = await assertDeliveredWithinBound(fixture, board);
        expect(elapsedMs).toBeLessThanOrEqual(RECHECK_INTERVAL_MS);
        expect(board.realtimeDelivered()).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
