/**
 * Timer settlement (`bbb_settle_card_effects`) — live integration
 * (card-behavior Task 12.7).
 *
 * Gated on SUPABASE_DB_URL; runs only under `npm run test:integration` (which
 * loads .env.local). The default hermetic `npm test` sees the variable unset and
 * skips the whole suite (Requirement 24.4). The "no schedule" property of
 * migration 0014 is covered by the hermetic text test
 * `supabase/__tests__/cardEffectSweep.migration.test.ts` (Task 12.8), not here.
 *
 * Coverage:
 *   1. Migrations 0013/0014 applied: the settle function exists with its
 *      (uuid, boolean, timestamptz) signature, the browser roles cannot execute
 *      it, and the `game_events_effect_transition_once` partial unique index is
 *      present.
 *   2. SQL/pure agreement: on a seeded live game covering every activation /
 *      expiry predicate (unannounced, cancelled before / at the boundary,
 *      consumed, open-ended, future, shared boundary times), calling
 *      `bbb_settle_card_effects(game, true, p_now)` at a sequence of instants
 *      appends exactly the transitions `planEffectTransitions` (lib/cards/
 *      effects.ts) plans for the same records at the same instant, in the same
 *      order, and returns that count (Req 19.9, 20.3b). A non-live game is a
 *      no-op.
 *   3. Idempotency across concurrent callers: a Settle_Nudge (route), a
 *      Card_Behavior_Mutation's lazy settle (a rejected `/cards/discard`), the
 *      Cron_Route, and a direct skip-locked call race on one game — both while
 *      the game lock is held by a third transaction and free-running — and
 *      every due transition is announced exactly once, with contiguous seqs
 *      (Req 20.4).
 *   4. The partial unique index rejects a duplicate transition event, both on a
 *      direct insert and when an announced flag is bypassed so the settle
 *      function itself tries to re-append (the whole call rolls back).
 *
 * Server time: the machine clock can drift from the DB clock (observed ~20 s),
 * so every fixture timestamp is derived from the database's `clock_timestamp()`.
 *
 * Requirements: 19.9, 20.3b, 20.4, 24.4.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  planEffectTransitions,
  type EffectRecord,
  type EffectTransition,
} from "@/lib/cards/effects";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());
const DB_TEST_TIMEOUT_MS = 90_000;
const SESSION_HEADER = "x-bbb-session-id";
const ADMIN_PREFIX = "it-sweep-admin-";
const MINUTE = 60_000;
/** How long the held lock must keep the waiting callers pending. */
const HELD_LOCK_OBSERVE_MS = 500;
/** Upper bound for a skip-locked caller to return while the lock is held. */
const SKIP_LOCKED_DEADLINE_MS = 20_000;
/** A test-only cron bearer; the original env value is restored afterwards. */
const TEST_CRON_SECRET = `it-sweep-cron-${randomUUID()}`;

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

async function settleRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/effects/settle/route")
> {
  return import("@/app/api/games/[gameId]/effects/settle/route");
}
async function discardRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/cards/discard/route")
> {
  return import("@/app/api/games/[gameId]/cards/discard/route");
}
async function cronRoute(): Promise<
  typeof import("@/app/api/cron/card-effects/route")
> {
  return import("@/app/api/cron/card-effects/route");
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly gameId: string;
  readonly teamAId: string;
  readonly teamBId: string;
  readonly sessionA: string;
  readonly scoringBarId: string;
}

/** One seeded card_effects row, with times as minute offsets from the DB `T`. */
interface EffectSeed {
  readonly label: string;
  readonly slug: string;
  readonly kind: EffectRecord["kind"];
  readonly startMs: number;
  readonly endMs: number | null;
  readonly startAnnounced?: boolean;
  readonly endAnnounced?: boolean;
  readonly cancelledMs?: number;
  readonly cancelReason?: "host" | "game_ended" | "protection_released";
  readonly consumedMs?: number;
}

async function dbNowMs(): Promise<number> {
  const { withTransaction } = await db();
  const { rows } = await withTransaction((tx) =>
    tx.query(`select date_trunc('milliseconds', clock_timestamp()) as t`),
  );
  return toMs(rows[0]?.t);
}

function toMs(value: unknown): number {
  return value instanceof Date
    ? value.getTime()
    : new Date(String(value)).getTime();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value == null ? null : iso(toMs(value));
}

async function createFixture(
  lifecycle: "live" | "lobby" = "live",
): Promise<Fixture> {
  const { withTransaction } = await db();
  const adminSession = `${ADMIN_PREFIX}${randomUUID()}`;
  const sessionA = `it-sweep-a-${randomUUID()}`;
  return withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, $3, case when $4::boolean then now() else null end)
       returning id`,
      [
        adminSession,
        `ITSWP${randomUUID().slice(0, 8)}`,
        lifecycle,
        lifecycle === "live",
      ],
    );
    const gameId = String(game.rows[0]?.id);
    const teamA = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Sweep A', '#e6194b') returning id`,
      [gameId],
    );
    const teamAId = String(teamA.rows[0]?.id);
    const teamB = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Sweep B', '#4363d8') returning id`,
      [gameId],
    );
    const teamBId = String(teamB.rows[0]?.id);
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Sweep A player')`,
      [gameId, teamAId, sessionA],
    );
    const bars: Record<string, string> = {};
    for (const [key, name] of [
      ["start", "Sweep Start"],
      ["finish", "Sweep Finish"],
      ["scoring", "Sweep Scoring"],
    ] as const) {
      const bar = await tx.query(
        `insert into bars (game_id, name) values ($1, $2) returning id`,
        [gameId, name],
      );
      bars[key] = String(bar.rows[0]?.id);
    }
    await tx.query(
      `update games set start_bar_id = $2, finish_bar_id = $3 where id = $1`,
      [gameId, bars.start, bars.finish],
    );
    return { gameId, teamAId, teamBId, sessionA, scoringBarId: bars.scoring };
  });
}

const INSERT_EFFECT_SQL = `
insert into card_effects (
  game_id, slug, kind, owner_team_id, target_team_id, target_bar_id,
  target_bar_key, starts_at, ends_at, consumed_at, cancelled_at, cancel_reason,
  start_announced_at, end_announced_at, created_at
) values (
  $1, $2, $3, $4, $5, $6, $7,
  $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12,
  $13::timestamptz, $14::timestamptz, $15::timestamptz
)
returning id
`;

/** Insert the seeds at base time `t`; returns label -> effect id. */
async function seedEffects(
  fixture: Fixture,
  t: number,
  seeds: readonly EffectSeed[],
): Promise<Map<string, string>> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const s of seeds) {
      const barTargeted = s.kind === "bar_lock" || s.kind === "bonus_window";
      const { rows } = await tx.query(INSERT_EFFECT_SQL, [
        fixture.gameId,
        s.slug,
        s.kind,
        fixture.teamAId,
        s.kind === "next_claim_restriction" ? fixture.teamBId : null,
        barTargeted ? fixture.scoringBarId : null,
        barTargeted ? fixture.scoringBarId : null,
        iso(t + s.startMs),
        s.endMs === null ? null : iso(t + s.endMs),
        s.consumedMs === undefined ? null : iso(t + s.consumedMs),
        s.cancelledMs === undefined ? null : iso(t + s.cancelledMs),
        s.cancelledMs === undefined ? null : (s.cancelReason ?? "host"),
        s.startAnnounced ? iso(t + s.startMs) : null,
        s.endAnnounced && s.endMs !== null ? iso(t + s.endMs) : null,
        iso(t + Math.min(s.startMs, 0)),
      ]);
      ids.set(s.label, String(rows[0]?.id));
    }
    return ids;
  });
}

/** Read the game's effects in the pure EffectRecord shape the planner takes. */
async function readEffectRecords(gameId: string): Promise<EffectRecord[]> {
  const { withTransaction } = await db();
  const { rows } = await withTransaction((tx) =>
    tx.query(
      `select id, slug, kind, source_play_id, source_challenge_id,
              owner_team_id, target_team_id, target_bar_key, starts_at, ends_at,
              params, attached_claim_id, attached_bar_id, protected_points,
              consumed_at, cancelled_at, cancel_reason,
              start_announced_at, end_announced_at
         from card_effects where game_id = $1 order by id`,
      [gameId],
    ),
  );
  const str = (v: unknown): string | null => (v == null ? null : String(v));
  return rows.map((row) => ({
    effectId: String(row.id),
    slug: String(row.slug) as EffectRecord["slug"],
    kind: String(row.kind) as EffectRecord["kind"],
    sourcePlayId: str(row.source_play_id),
    sourceChallengeId: str(row.source_challenge_id),
    ownerTeamId: str(row.owner_team_id),
    targetTeamId: str(row.target_team_id),
    targetBarKey: str(row.target_bar_key),
    startsAt: iso(toMs(row.starts_at)),
    endsAt: isoOrNull(row.ends_at),
    params: {},
    attachedClaimId: str(row.attached_claim_id),
    attachedBarKey: str(row.attached_bar_id),
    protectedPoints:
      row.protected_points == null ? null : Number(row.protected_points),
    consumedAt: isoOrNull(row.consumed_at),
    cancelledAt: isoOrNull(row.cancelled_at),
    cancelReason: (row.cancel_reason ?? null) as EffectRecord["cancelReason"],
    startAnnounced: row.start_announced_at != null,
    endAnnounced: row.end_announced_at != null,
  }));
}

interface TransitionEvent {
  readonly seq: number;
  readonly type: string;
  readonly effectId: string;
  readonly payload: Record<string, unknown>;
}

async function eventsAfter(
  gameId: string,
  baselineSeq: number,
): Promise<TransitionEvent[]> {
  const { withTransaction } = await db();
  const { rows } = await withTransaction((tx) =>
    tx.query(
      `select seq, event_type, payload from game_events
        where game_id = $1 and seq > $2 order by seq`,
      [gameId, baselineSeq],
    ),
  );
  return rows.map((row) => {
    const payload = (
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    ) as Record<string, unknown>;
    return {
      seq: Number(row.seq),
      type: String(row.event_type),
      effectId: String(payload?.effectId ?? ""),
      payload,
    };
  });
}

async function maxSeq(gameId: string): Promise<number> {
  const { withTransaction } = await db();
  const { rows } = await withTransaction((tx) =>
    tx.query(
      `select coalesce(max(seq), 0) as seq from game_events where game_id = $1`,
      [gameId],
    ),
  );
  return Number(rows[0]?.seq ?? 0);
}

/** Direct call of the settle function in its own transaction. */
async function settleDirect(
  gameId: string | null,
  wait: boolean,
  nowMs: number | null,
): Promise<number> {
  const { withTransaction } = await db();
  const { rows } = await withTransaction((tx) =>
    tx.query(
      `select bbb_settle_card_effects($1::uuid, $2, $3::timestamptz) as appended`,
      [gameId, wait, nowMs === null ? null : iso(nowMs)],
    ),
  );
  return Number(rows[0]?.appended ?? 0);
}

function transitionType(t: EffectTransition): string {
  return t.kind === "activated" ? "effect_activated" : "effect_expired";
}

function expectContiguous(events: readonly TransitionEvent[], from: number) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => from + 1 + i));
}

/** The appended events are exactly `plan`, in plan order, one per transition. */
function expectEventsMatchPlan(
  events: readonly TransitionEvent[],
  plan: readonly EffectTransition[],
  baselineSeq: number,
): void {
  const context = JSON.stringify({
    plan,
    events: events.map((e) => [e.seq, e.type, e.effectId]),
  });
  expect(
    events.map((e) => [e.type, e.effectId]),
    context,
  ).toEqual(plan.map((t) => [transitionType(t), t.effectId]));
  expectContiguous(events, baselineSeq);
  events.forEach((event, i) => {
    const t = plan[i]!;
    // The event's boundary is the planner's atMs (startsAt / endsAt).
    const boundary =
      t.kind === "activated" ? event.payload.startsAt : event.payload.endsAt;
    expect(Date.parse(String(boundary)), context).toBe(t.atMs);
  });
}

// ---------------------------------------------------------------------------
// Route invocation.
// ---------------------------------------------------------------------------

function ctxFor(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

interface RouteResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function toResult(response: Response): Promise<RouteResult> {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Settle_Nudge from a member's board. */
async function postNudge(fixture: Fixture): Promise<RouteResult> {
  const { POST } = await settleRoute();
  return toResult(
    await POST(
      new Request(
        `http://localhost/api/games/${fixture.gameId}/effects/settle`,
        { method: "POST", headers: { [SESSION_HEADER]: fixture.sessionA } },
      ),
      ctxFor(fixture.gameId),
    ),
  );
}

/** A Card_Behavior_Mutation that is rejected (unknown card) but still settles lazily. */
async function postRejectedDiscard(fixture: Fixture): Promise<RouteResult> {
  const { POST } = await discardRoute();
  return toResult(
    await POST(
      new Request(
        `http://localhost/api/games/${fixture.gameId}/cards/discard`,
        {
          method: "POST",
          headers: {
            [SESSION_HEADER]: fixture.sessionA,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            cardId: `it-sweep-no-such-card-${randomUUID()}`,
          }),
        },
      ),
      ctxFor(fixture.gameId),
    ),
  );
}

/** The optional Cron_Route (all live games, skip locked). */
async function getCron(): Promise<RouteResult> {
  const { GET } = await cronRoute();
  return toResult(
    await GET(
      new Request("http://localhost/api/cron/card-effects", {
        method: "GET",
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Lock helpers (same pattern as cardBehaviorRace.integration.test.ts).
// ---------------------------------------------------------------------------

async function holdGameLock(
  gameId: string,
): Promise<{ release: () => Promise<void> }> {
  const { withTransaction } = await db();
  let releaseLock!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const done = withTransaction(async (tx) => {
    await tx.query(`select id from games where id = $1 for update`, [gameId]);
    signalLocked();
    await gate;
    return undefined;
  });
  await Promise.race([locked, done]);
  return {
    release: async () => {
      releaseLock();
      await done;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function track<T>(promise: Promise<T>): { settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not return within ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function purgeSweepFixtures(): Promise<void> {
  const { withTransaction } = await db();
  await withTransaction(async (tx) => {
    await tx.query(
      `alter table game_events disable trigger game_events_no_update_delete`,
    );
    await tx.query(
      `alter table score_ledger_entries disable trigger score_ledger_entries_no_update_delete`,
    );
    await tx.query(`delete from games where admin_session_id like $1`, [
      `${ADMIN_PREFIX}%`,
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

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

/**
 * Covers every planner predicate. Offsets are relative to the DB time `T`; the
 * agreement test settles at T-25m, T-12m, T, and T+20m.
 */
const AGREEMENT_SEEDS: readonly EffectSeed[] = [
  // Expiry due from T-5m; shares its boundary with k1/k2 (ordered by id).
  {
    label: "a",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -20 * MINUTE,
    endMs: -5 * MINUTE,
    startAnnounced: true,
  },
  {
    label: "k1",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -20 * MINUTE,
    endMs: -5 * MINUTE,
    startAnnounced: true,
  },
  {
    label: "k2",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -20 * MINUTE,
    endMs: -5 * MINUTE,
    startAnnounced: true,
  },
  // Delayed Cancel Culture: activation at T-2m, expiry at T+13m.
  {
    label: "b",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: -2 * MINUTE,
    endMs: 13 * MINUTE,
  },
  // Activation and expiry both past and unannounced.
  {
    label: "c",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: -30 * MINUTE,
    endMs: -15 * MINUTE,
  },
  // Cancelled before its start: never announced.
  {
    label: "d",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: -5 * MINUTE,
    endMs: 10 * MINUTE,
    cancelledMs: -10 * MINUTE,
  },
  // Cancelled before its end: no expiry.
  {
    label: "e",
    slug: "happy-hour",
    kind: "bonus_window",
    startMs: -40 * MINUTE,
    endMs: -1 * MINUTE,
    startAnnounced: true,
    cancelledMs: -3 * MINUTE,
  },
  // Consumed before its end: no expiry.
  {
    label: "f",
    slug: "power-hour",
    kind: "draw_override",
    startMs: -40 * MINUTE,
    endMs: -1 * MINUTE,
    startAnnounced: true,
    consumedMs: -5 * MINUTE,
  },
  // Future: activation at T+5m, expiry at T+20m (both due by the last instant).
  {
    label: "g",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: 5 * MINUTE,
    endMs: 20 * MINUTE,
  },
  // Fully announced already.
  {
    label: "h",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -40 * MINUTE,
    endMs: -25 * MINUTE,
    startAnnounced: true,
    endAnnounced: true,
  },
  // Open-ended: never expires.
  {
    label: "i",
    slug: "pioneer",
    kind: "next_claim_restriction",
    startMs: -40 * MINUTE,
    endMs: null,
    startAnnounced: true,
  },
  // Cancelled exactly at its end (game end): expiry still due (cancelled >= end).
  {
    label: "j",
    slug: "happy-hour",
    kind: "bonus_window",
    startMs: -60 * MINUTE,
    endMs: -8 * MINUTE,
    startAnnounced: true,
    cancelledMs: -8 * MINUTE,
    cancelReason: "game_ended",
  },
  // Activation exactly at the T-12m instant (starts_at <= now).
  {
    label: "l",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: -12 * MINUTE,
    endMs: 3 * MINUTE,
  },
];

/** Due by the DB clock at seed time: 3 expiries + 1 activation; one not due. */
const DUE_NOW_SEEDS: readonly EffectSeed[] = [
  {
    label: "x1",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -10 * MINUTE,
    endMs: -5_000,
    startAnnounced: true,
  },
  {
    label: "x2",
    slug: "crop-dusting",
    kind: "bar_lock",
    startMs: -10 * MINUTE,
    endMs: -5_000,
    startAnnounced: true,
  },
  {
    label: "x3",
    slug: "power-hour",
    kind: "draw_override",
    startMs: -10 * MINUTE,
    endMs: -4_000,
    startAnnounced: true,
  },
  {
    label: "cc",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: -3_000,
    endMs: 15 * MINUTE,
  },
  {
    label: "later",
    slug: "cancel-culture",
    kind: "radius_lock",
    startMs: 10 * MINUTE,
    endMs: 25 * MINUTE,
  },
];
const DUE_NOW_COUNT = 4;

/** Seed a live game whose transitions are due now; returns the expected plan. */
async function seedDueNow(): Promise<{
  fixture: Fixture;
  plan: EffectTransition[];
  baselineSeq: number;
}> {
  const fixture = await createFixture();
  const t = await dbNowMs();
  await seedEffects(fixture, t, DUE_NOW_SEEDS);
  const plan = planEffectTransitions(
    await readEffectRecords(fixture.gameId),
    t,
    "live",
  );
  expect(plan).toHaveLength(DUE_NOW_COUNT);
  return { fixture, plan, baselineSeq: await maxSeq(fixture.gameId) };
}

/** Every due transition announced exactly once; nothing further is due. */
async function expectSettledExactlyOnce(
  fixture: Fixture,
  plan: readonly EffectTransition[],
  baselineSeq: number,
): Promise<void> {
  const events = await eventsAfter(fixture.gameId, baselineSeq);
  // The first lock holder settled every (already-due) transition in one call,
  // so the log is exactly the plan, in plan order, with contiguous seqs.
  expectEventsMatchPlan(events, plan, baselineSeq);
  const after = planEffectTransitions(
    await readEffectRecords(fixture.gameId),
    await dbNowMs(),
    "live",
  );
  expect(after).toEqual([]);
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

describe.skipIf(!DB_CONFIGURED)(
  "timer settlement: bbb_settle_card_effects (R19.9, R20.3b, R20.4)",
  () => {
    const originalCronSecret = process.env.CRON_SECRET;
    let agreement:
      { fixture: Fixture; ids: Map<string, string>; t: number } | undefined;

    beforeAll(async () => {
      process.env.CRON_SECRET = TEST_CRON_SECRET;
      await purgeSweepFixtures();
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalCronSecret;
      if (!serverDb) return;
      try {
        await purgeSweepFixtures();
      } finally {
        await serverDb.closeDb();
      }
    }, DB_TEST_TIMEOUT_MS);

    it(
      "migrations 0013/0014 are applied: settle function, grants, and transition index",
      async () => {
        const { withTransaction } = await db();
        const rows = await withTransaction(async (tx) => {
          const fn = await tx.query(
            `select p.oid::regprocedure::text as sig,
                    pg_get_function_result(p.oid) as result
               from pg_proc p
              where p.proname = 'bbb_settle_card_effects'`,
          );
          const grants = await tx.query(
            `select r.rolname,
                    has_function_privilege(r.rolname,
                      'bbb_settle_card_effects(uuid, boolean, timestamptz)',
                      'execute') as can_execute
               from pg_roles r
              where r.rolname in ('anon', 'authenticated')`,
          );
          const index = await tx.query(
            `select indexdef from pg_indexes
              where indexname = 'game_events_effect_transition_once'`,
          );
          return { fn: fn.rows, grants: grants.rows, index: index.rows };
        });

        expect(rows.fn).toHaveLength(1);
        expect(String(rows.fn[0]?.sig)).toBe(
          "bbb_settle_card_effects(uuid,boolean,timestamp with time zone)",
        );
        expect(String(rows.fn[0]?.result)).toBe("integer");
        for (const grant of rows.grants) {
          expect(grant.can_execute, String(grant.rolname)).toBe(false);
        }
        expect(rows.index).toHaveLength(1);
        expect(String(rows.index[0]?.indexdef)).toMatch(/unique/i);
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "agrees with planEffectTransitions at every instant on the seeded fixture",
      async () => {
        const fixture = await createFixture();
        const t = await dbNowMs();
        const ids = await seedEffects(fixture, t, AGREEMENT_SEEDS);
        agreement = { fixture, ids, t };
        const byId = new Map([...ids].map(([label, id]) => [id, label]));

        const instants = [-25 * MINUTE, -12 * MINUTE, 0, 20 * MINUTE];
        const expectedLabels: Record<number, string[]> = {
          [-25 * MINUTE]: ["activated:c"],
          [-12 * MINUTE]: ["expired:c", "activated:l"],
          0: [
            "expired:j",
            "expired:a/k",
            "expired:a/k",
            "expired:a/k",
            "activated:b",
          ],
          [20 * MINUTE]: ["expired:l", "activated:g", "expired:b", "expired:g"],
        };

        for (const offset of instants) {
          const nowMs = t + offset;
          const records = await readEffectRecords(fixture.gameId);
          const plan = planEffectTransitions(records, nowMs, "live");
          // Sanity-check the fixture exercises what we intend at this instant.
          expect(
            plan.map((p) => {
              const label = byId.get(p.effectId)!;
              return `${p.kind}:${["a", "k1", "k2"].includes(label) ? "a/k" : label}`;
            }),
            `instant ${offset / MINUTE}m`,
          ).toEqual(expectedLabels[offset]);

          const baselineSeq = await maxSeq(fixture.gameId);
          const appended = await settleDirect(fixture.gameId, true, nowMs);
          expect(appended).toBe(plan.length);
          const events = await eventsAfter(fixture.gameId, baselineSeq);
          expectEventsMatchPlan(events, plan, baselineSeq);
          for (const event of events) {
            expect(event.payload.slug).toBeTypeOf("string");
            expect(event.payload.effects).toHaveLength(1);
          }

          // Flags flipped: re-planning or re-settling at the same instant is a no-op.
          expect(
            planEffectTransitions(
              await readEffectRecords(fixture.gameId),
              nowMs,
              "live",
            ),
          ).toEqual([]);
          expect(await settleDirect(fixture.gameId, true, nowMs)).toBe(0);
          expect(await maxSeq(fixture.gameId)).toBe(baselineSeq + plan.length);
        }
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "is a no-op for a game that is not live",
      async () => {
        const fixture = await createFixture("lobby");
        const t = await dbNowMs();
        await seedEffects(fixture, t, DUE_NOW_SEEDS);
        const records = await readEffectRecords(fixture.gameId);
        expect(planEffectTransitions(records, t, "lobby")).toEqual([]);

        const baselineSeq = await maxSeq(fixture.gameId);
        expect(await settleDirect(fixture.gameId, true, t)).toBe(0);
        expect(await maxSeq(fixture.gameId)).toBe(baselineSeq);
        expect(await readEffectRecords(fixture.gameId)).toEqual(records);
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "announces each transition once when Settle_Nudge, a mutation's lazy settle, and the Cron_Route queue on a held lock",
      async () => {
        const { fixture, plan, baselineSeq } = await seedDueNow();

        const lock = await holdGameLock(fixture.gameId);
        let nudge!: Promise<RouteResult>;
        let discard!: Promise<RouteResult>;
        try {
          nudge = postNudge(fixture);
          discard = postRejectedDiscard(fixture);
          const nudgeTrack = track(nudge);
          const discardTrack = track(discard);

          // Skip-locked callers return without touching the locked game.
          const cron = await withDeadline(
            getCron(),
            SKIP_LOCKED_DEADLINE_MS,
            "cron",
          );
          expect(cron.status, JSON.stringify(cron.body)).toBe(200);
          expect(
            await withDeadline(
              settleDirect(fixture.gameId, false, null),
              SKIP_LOCKED_DEADLINE_MS,
              "skip-locked settle",
            ),
          ).toBe(0);

          // The waiting callers are blocked on the game lock.
          await sleep(HELD_LOCK_OBSERVE_MS);
          expect(nudgeTrack.settled(), "nudge bypassed the game lock").toBe(
            false,
          );
          expect(discardTrack.settled(), "discard bypassed the game lock").toBe(
            false,
          );
          expect(await maxSeq(fixture.gameId)).toBe(baselineSeq);
        } finally {
          await lock.release();
        }

        const [nudgeResult, discardResult] = await Promise.all([
          nudge,
          discard,
        ]);
        expect(nudgeResult.status, JSON.stringify(nudgeResult.body)).toBe(200);
        const nudgeAppended = Number(
          (nudgeResult.body.result as { appended?: unknown }).appended,
        );
        expect([0, DUE_NOW_COUNT]).toContain(nudgeAppended);
        // The discard is rejected (unknown card) but its lazy settle commits.
        expect(
          discardResult.status,
          JSON.stringify(discardResult.body),
        ).toBeGreaterThanOrEqual(400);
        expect(
          discardResult.status,
          JSON.stringify(discardResult.body),
        ).toBeLessThan(500);
        await expectSettledExactlyOnce(fixture, plan, baselineSeq);
        expect(Number(nudgeResult.body.seq)).toBeLessThanOrEqual(
          baselineSeq + DUE_NOW_COUNT,
        );

        // A second round of every caller appends nothing for this game.
        const settledSeq = await maxSeq(fixture.gameId);
        const [n1, n2, d1, c1, direct] = await Promise.all([
          postNudge(fixture),
          postNudge(fixture),
          postRejectedDiscard(fixture),
          getCron(),
          settleDirect(fixture.gameId, true, null),
        ]);
        for (const n of [n1, n2]) {
          expect(n.status).toBe(200);
          expect((n.body.result as { appended?: unknown }).appended).toBe(0);
          expect(n.body.seq).toBe(settledSeq);
        }
        expect(d1.status).toBeLessThan(500);
        expect(c1.status).toBe(200);
        expect(direct).toBe(0);
        expect(await maxSeq(fixture.gameId)).toBe(settledSeq);
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "announces each transition once under a free-running race of every caller",
      async () => {
        const { fixture, plan, baselineSeq } = await seedDueNow();

        const [n1, n2, d1, c1, direct] = await Promise.all([
          postNudge(fixture),
          postNudge(fixture),
          postRejectedDiscard(fixture),
          getCron(),
          settleDirect(fixture.gameId, false, null),
        ]);
        expect(n1.status).toBe(200);
        expect(n2.status).toBe(200);
        expect(d1.status).toBeGreaterThanOrEqual(400);
        expect(d1.status).toBeLessThan(500);
        expect(c1.status).toBe(200);
        const perGame = [n1, n2].map((n) =>
          Number((n.body.result as { appended?: unknown }).appended),
        );
        // Whichever per-game caller appended, it appended all or nothing.
        for (const count of [...perGame, direct]) {
          expect([0, DUE_NOW_COUNT]).toContain(count);
        }
        await expectSettledExactlyOnce(fixture, plan, baselineSeq);
      },
      DB_TEST_TIMEOUT_MS,
    );

    it(
      "the partial unique index rejects a duplicate transition event",
      async () => {
        expect(agreement, "agreement fixture missing").toBeDefined();
        const { fixture, ids, t } = agreement!;
        const effectId = ids.get("a")!;
        const { withTransaction } = await db();
        const baselineSeq = await maxSeq(fixture.gameId);

        // 1. A direct duplicate insert of an already-appended effect_expired.
        // The payload is built in SQL so it is a jsonb OBJECT like the settle
        // function's: postgres.js serializes a string bound to `$n::jsonb` as a
        // JSON string scalar, whose `->> 'effectId'` is null (never indexed).
        const directError = await withTransaction((tx) =>
          tx.query(
            `insert into game_events (game_id, seq, event_type, actor_kind, payload)
             values ($1,
                     (select coalesce(max(seq), 0) + 1 from game_events where game_id = $1),
                     'effect_expired', 'system',
                     jsonb_build_object('effectId', $2::text))`,
            [fixture.gameId, effectId],
          ),
        ).then(
          () => null,
          (error: unknown) =>
            error as { code?: string; constraint_name?: string },
        );
        expect(directError, "duplicate insert was accepted").not.toBeNull();
        expect(directError?.code).toBe("23505");
        expect(directError?.constraint_name).toBe(
          "game_events_effect_transition_once",
        );

        // 2. Bypass the announced flag so the settle function itself re-claims
        // the expiry: the index rejects the re-append and the whole call rolls
        // back (flag reset included).
        const settleError = await withTransaction(async (tx) => {
          await tx.query(
            `update card_effects set end_announced_at = null where id = $1`,
            [effectId],
          );
          await tx.query(
            `select bbb_settle_card_effects($1, true, $2::timestamptz)`,
            [fixture.gameId, iso(t + 20 * MINUTE)],
          );
          return undefined;
        }).then(
          () => null,
          (error: unknown) =>
            error as { code?: string; constraint_name?: string },
        );
        expect(settleError, "settle re-appended a transition").not.toBeNull();
        expect(settleError?.code).toBe("23505");
        expect(settleError?.constraint_name).toBe(
          "game_events_effect_transition_once",
        );

        expect(await maxSeq(fixture.gameId)).toBe(baselineSeq);
        const record = (await readEffectRecords(fixture.gameId)).find(
          (r) => r.effectId === effectId,
        );
        expect(record?.endAnnounced).toBe(true);
      },
      DB_TEST_TIMEOUT_MS,
    );
  },
);
