/**
 * Claim vs. card-play races — live integration (card-behavior Task 7.12).
 *
 * Gated on SUPABASE_DB_URL; runs only under `npm run test:integration` (which
 * loads .env.local). The default hermetic `npm test` sees the variable unset and
 * skips the whole suite (Requirement 24.4).
 *
 * Requirement 19.2: claim and card-play mutations serialize per game, so each
 * evaluates against every Effect committed before it. Both routes take the
 * `FOR UPDATE` game-row lock as the first statement of their transaction. This
 * suite proves the serialization against real Postgres by:
 *
 *   1. holding the game-row lock from a third transaction, firing a real
 *      `/cards/play` and a real `/claims` request at the same game, and showing
 *      that neither completes while the lock is held (both queue on the lock);
 *   2. releasing the lock and asserting the committed outcome is one of the two
 *      serial orders, never an interleaving:
 *        - play first  → the claim is rejected `blocked`, listing the Crop
 *          Dusting `bar_lock` (or the challenge-gate `challenge`), and no
 *          claim by the target team exists on the bar;
 *        - claim first → both succeed, the claim's events all precede
 *          `card_played` in `seq`, and the claim was recorded before the
 *          Effect / Challenge was created;
 *      and in both orders the mutations' `game_events` occupy contiguous,
 *      non-interleaved `seq` ranges;
 *   3. a free-running (no held lock) `Promise.all` race satisfies the same
 *      invariant.
 *
 * Covered card families: Crop Dusting (bar-targeting timed lock) and Go Piss
 * Girl (team-targeting challenge gate).
 *
 * Requirements: 19.2, 24.4.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const DB_CONFIGURED = Boolean(process.env.SUPABASE_DB_URL?.trim());
const DB_TEST_TIMEOUT_MS = 60_000;
const SESSION_HEADER = "x-bbb-session-id";
const ADMIN_PREFIX = "it-race-admin-";
/** How long the held lock must keep both requests pending. */
const HELD_LOCK_OBSERVE_MS = 500;
/** Stagger so the first request is queued on the lock before the second. */
const STAGGER_MS = 150;

type ServerDb = typeof import("@/lib/db/server");
let serverDb: ServerDb | undefined;
async function db(): Promise<ServerDb> {
  serverDb ??= await import("@/lib/db/server");
  return serverDb;
}

async function playRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/cards/play/route")
> {
  return import("@/app/api/games/[gameId]/cards/play/route");
}
async function claimsRoute(): Promise<
  typeof import("@/app/api/games/[gameId]/claims/route")
> {
  return import("@/app/api/games/[gameId]/claims/route");
}
async function persist(): Promise<typeof import("@/lib/cards/persistence")> {
  return import("@/lib/cards/persistence");
}

type RaceSlug = "crop-dusting" | "go-piss-girl";
type FirstMover = "play" | "claim";

interface Fixture {
  readonly gameId: string;
  /** Casting team. */
  readonly teamAId: string;
  /** Claiming (and, for the challenge, targeted) team. */
  readonly teamBId: string;
  readonly sessionA: string;
  readonly sessionB: string;
  readonly scoringBarId: string;
}

interface RouteResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface EventRow {
  readonly seq: number;
  readonly type: string;
  readonly actorTeamId: string | null;
}

const createdGameIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const adminSession = `${ADMIN_PREFIX}${randomUUID()}`;
  const sessionA = `it-race-a-${randomUUID()}`;
  const sessionB = `it-race-b-${randomUUID()}`;
  const { withTransaction } = await db();

  const fixture = await withTransaction<Fixture>(async (tx) => {
    const game = await tx.query(
      `insert into games (admin_session_id, join_code, lifecycle, live_started_at)
       values ($1, $2, 'live', now()) returning id`,
      [adminSession, `ITRACE${randomUUID().slice(0, 8)}`],
    );
    const gameId = String(game.rows[0]?.id);

    const teamA = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Race A', '#e6194b') returning id`,
      [gameId],
    );
    const teamAId = String(teamA.rows[0]?.id);
    const teamB = await tx.query(
      `insert into teams (game_id, name, color) values ($1, 'Race B', '#4363d8') returning id`,
      [gameId],
    );
    const teamBId = String(teamB.rows[0]?.id);

    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Race A player')`,
      [gameId, teamAId, sessionA],
    );
    await tx.query(
      `insert into players (game_id, team_id, session_id, display_name)
       values ($1, $2, $3, 'Race B player')`,
      [gameId, teamBId, sessionB],
    );

    const bars: Record<string, string> = {};
    for (const [key, name] of [
      ["start", "Race Start"],
      ["finish", "Race Finish"],
      ["scoring", "Race Scoring"],
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

    return {
      gameId,
      teamAId,
      teamBId,
      sessionA,
      sessionB,
      scoringBarId: bars.scoring,
    };
  });

  createdGameIds.push(fixture.gameId);
  return fixture;
}

/** Put `slug` into team A's hand via the persistence helper the dev inject uses. */
async function putInHand(fixture: Fixture, slug: RaceSlug): Promise<string> {
  const { withTransaction } = await db();
  const { injectCardToHand } = await persist();
  const result = await withTransaction((tx) =>
    injectCardToHand(
      tx,
      { gameId: fixture.gameId, teamId: fixture.teamAId },
      slug,
    ),
  );
  if (!result.ok) throw new Error(`inject ${slug} failed: ${result.reason}`);
  return result.cardId;
}

function ctxFor(gameId: string): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId }) };
}

function jsonRequest(
  url: string,
  sessionId: string,
  body: Record<string, unknown>,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      [SESSION_HEADER]: sessionId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function toResult(response: Response): Promise<RouteResult> {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Team A plays `cardId`: Crop Dusting on the scoring bar, Go Piss Girl on team B. */
async function postPlay(
  fixture: Fixture,
  slug: RaceSlug,
  cardId: string,
): Promise<RouteResult> {
  const { POST } = await playRoute();
  const body =
    slug === "crop-dusting"
      ? { cardId, targetBarId: fixture.scoringBarId }
      : { cardId, targetTeamId: fixture.teamBId };
  return toResult(
    await POST(
      jsonRequest(
        `http://localhost/api/games/${fixture.gameId}/cards/play`,
        fixture.sessionA,
        body,
      ),
      ctxFor(fixture.gameId),
    ),
  );
}

/** Team B claims the scoring bar. */
async function postClaim(fixture: Fixture): Promise<RouteResult> {
  const { POST } = await claimsRoute();
  return toResult(
    await POST(
      jsonRequest(
        `http://localhost/api/games/${fixture.gameId}/claims`,
        fixture.sessionB,
        {
          action: "claim",
          barId: fixture.scoringBarId,
          allMembersPresent: true,
          finishedDrinkCount: 1,
        },
      ),
      ctxFor(fixture.gameId),
    ),
  );
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

/**
 * Hold the game-row `FOR UPDATE` lock in its own transaction until `release()`
 * is called. Resolves once the lock is actually held.
 */
async function holdGameLock(gameId: string): Promise<{
  release: () => Promise<void>;
}> {
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
  // Surface a failure to acquire rather than hanging on `locked`.
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

/** Track whether a promise has settled, without consuming its result. */
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

interface RaceState {
  /** Mutation events appended after the pre-race baseline, in seq order. */
  readonly events: readonly EventRow[];
  /** Team B's active claims on the scoring bar, with claim time. */
  readonly teamBClaims: readonly { claimedAt: Date }[];
  /** Creation time of the play's Effect (Crop) or Challenge (Go Piss Girl). */
  readonly playArtifactCreatedAt: readonly Date[];
}

async function readRaceState(
  fixture: Fixture,
  slug: RaceSlug,
  baselineSeq: number,
): Promise<RaceState> {
  const { withTransaction } = await db();
  return withTransaction(async (tx) => {
    const events = await tx.query(
      `select seq, event_type, actor_team_id
         from game_events
        where game_id = $1 and seq > $2
        order by seq`,
      [fixture.gameId, baselineSeq],
    );
    const claims = await tx.query(
      `select claimed_at from claims
        where game_id = $1 and team_id = $2 and bar_id = $3 and revoked_at is null`,
      [fixture.gameId, fixture.teamBId, fixture.scoringBarId],
    );
    const artifacts =
      slug === "crop-dusting"
        ? await tx.query(
            `select created_at from card_effects
              where game_id = $1 and kind = 'bar_lock' and target_bar_id = $2`,
            [fixture.gameId, fixture.scoringBarId],
          )
        : await tx.query(
            `select created_at from card_challenges
              where game_id = $1 and target_team_id = $2 and status = 'open'`,
            [fixture.gameId, fixture.teamBId],
          );
    return {
      events: events.rows.map((row) => ({
        seq: Number(row.seq),
        type: String(row.event_type),
        actorTeamId:
          row.actor_team_id == null ? null : String(row.actor_team_id),
      })),
      teamBClaims: claims.rows.map((row) => ({
        claimedAt: new Date(String(row.claimed_at)),
      })),
      playArtifactCreatedAt: artifacts.rows.map(
        (row) => new Date(String(row.created_at)),
      ),
    };
  });
}

/**
 * Assert the committed state is exactly one of the two serial orders and never
 * an interleaving. Returns which order was observed.
 */
async function assertSerialized(
  fixture: Fixture,
  slug: RaceSlug,
  baselineSeq: number,
  play: RouteResult,
  claim: RouteResult,
): Promise<FirstMover> {
  const outcome = JSON.stringify({ play, claim });
  // The play never depends on the claim, so it succeeds in either order.
  expect(play.status, outcome).toBe(200);

  const state = await readRaceState(fixture, slug, baselineSeq);
  const expectedBlockKind = slug === "crop-dusting" ? "bar_lock" : "challenge";

  // The play committed its Effect / Challenge exactly once.
  expect(state.playArtifactCreatedAt, outcome).toHaveLength(1);
  const artifactAt = state.playArtifactCreatedAt[0]!;

  const playEvents = state.events.filter((e) => e.type === "card_played");
  expect(playEvents, outcome).toHaveLength(1);
  const playSeq = playEvents[0]!.seq;
  expect(play.body.seq, outcome).toBe(playSeq);

  // Every other appended event belongs to team B's claim mutation.
  const claimEvents = state.events.filter((e) => e.type !== "card_played");
  for (const event of claimEvents) {
    expect(event.actorTeamId, outcome).toBe(fixture.teamBId);
  }

  // seq values are contiguous: one mutation's events never interleave with the
  // other's (each committed under the lock as one unit).
  const seqs = state.events.map((e) => e.seq);
  expect(seqs, outcome).toEqual(seqs.map((_, i) => baselineSeq + 1 + i));

  if (claim.status === 200) {
    // Claim first: it evaluated before the Effect / Challenge existed.
    expect(state.teamBClaims, outcome).toHaveLength(1);
    expect(
      state.events.some((e) => e.type === "claim_recorded"),
      outcome,
    ).toBe(true);
    expect(playSeq, outcome).toBe(seqs[seqs.length - 1]);
    for (const event of claimEvents) {
      expect(event.seq, outcome).toBeLessThan(playSeq);
    }
    expect(
      state.teamBClaims[0]!.claimedAt.getTime(),
      outcome,
    ).toBeLessThanOrEqual(artifactAt.getTime());
    expect(claim.body.seq, outcome).toBe(playSeq - 1);
    return "claim";
  }

  // Play first: the claim saw the committed Effect / Challenge and was blocked,
  // writing nothing.
  expect(claim.status, outcome).toBe(409);
  expect(claim.body.applied, outcome).toBe(false);
  expect(claim.body.error, outcome).toBe("blocked");
  const blocks = (claim.body.details as { blocks?: { kind: string }[] })
    ?.blocks;
  expect(
    blocks?.some((b) => b.kind === expectedBlockKind),
    outcome,
  ).toBe(true);
  expect(state.teamBClaims, outcome).toHaveLength(0);
  expect(claimEvents, outcome).toHaveLength(0);
  expect(seqs, outcome).toEqual([playSeq]);
  return "play";
}

async function purgeRaceFixtures(): Promise<void> {
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

const CASES: readonly (readonly [RaceSlug, FirstMover])[] = [
  ["crop-dusting", "play"],
  ["crop-dusting", "claim"],
  ["go-piss-girl", "play"],
  ["go-piss-girl", "claim"],
];

describe.skipIf(!DB_CONFIGURED)(
  "claim vs. card-play races serialize under the game lock (R19.2)",
  () => {
    beforeAll(async () => {
      await purgeRaceFixtures();
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (!serverDb) return;
      try {
        if (createdGameIds.length > 0) await purgeRaceFixtures();
      } finally {
        await serverDb.closeDb();
      }
    }, DB_TEST_TIMEOUT_MS);

    it.each(CASES)(
      "%s play and an opposing claim queue on the held lock (%s fired first) and commit serially",
      async (slug, firstMover) => {
        const fixture = await createFixture();
        const cardId = await putInHand(fixture, slug);
        const baselineSeq = await maxSeq(fixture.gameId);

        const lock = await holdGameLock(fixture.gameId);
        let play!: Promise<RouteResult>;
        let claim!: Promise<RouteResult>;
        try {
          if (firstMover === "play") {
            play = postPlay(fixture, slug, cardId);
            await sleep(STAGGER_MS);
            claim = postClaim(fixture);
          } else {
            claim = postClaim(fixture);
            await sleep(STAGGER_MS);
            play = postPlay(fixture, slug, cardId);
          }
          const playTrack = track(play);
          const claimTrack = track(claim);

          // Both mutations are blocked on the game-row lock: neither can read
          // state, evaluate, or commit while another transaction holds it.
          await sleep(HELD_LOCK_OBSERVE_MS);
          expect(playTrack.settled(), "play bypassed the game lock").toBe(
            false,
          );
          expect(claimTrack.settled(), "claim bypassed the game lock").toBe(
            false,
          );
          expect(await maxSeq(fixture.gameId)).toBe(baselineSeq);
        } finally {
          await lock.release();
        }

        const [playResult, claimResult] = await Promise.all([play, claim]);
        await assertSerialized(
          fixture,
          slug,
          baselineSeq,
          playResult,
          claimResult,
        );
      },
      DB_TEST_TIMEOUT_MS,
    );

    it.each(["crop-dusting", "go-piss-girl"] as const)(
      "a free-running %s play / claim race lands in one serial order",
      async (slug) => {
        const fixture = await createFixture();
        const cardId = await putInHand(fixture, slug);
        const baselineSeq = await maxSeq(fixture.gameId);

        const [playResult, claimResult] = await Promise.all([
          postPlay(fixture, slug, cardId),
          postClaim(fixture),
        ]);
        await assertSerialized(
          fixture,
          slug,
          baselineSeq,
          playResult,
          claimResult,
        );
      },
      DB_TEST_TIMEOUT_MS,
    );
  },
);
