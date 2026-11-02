/**
 * Card-play route tests (card-behavior Task 7.2), reworked onto the
 * Card_Behavior_Mutation pipeline (design.md "Mutation pipeline"):
 *
 *   resolveCardActor → clock_timestamp() → settleDueTransitions →
 *   loadBehaviorState → planCardPlay → writePlanAndAppend
 *
 * These are HERMETIC route tests: a fake {@link QueryRunner} answers exactly the
 * statements the pipeline issues (membership + lifecycle + player, the server
 * clock, `bbb_settle_card_effects`, the `loadBehaviorState` SELECTs, the
 * `resolveGameBar` lookups, the domain writes, and `appendEvent`), and no live
 * database is touched, so this runs under the default `npm test`. The pure
 * planner {@link planCardPlay} is mocked so each test drives a single, crafted
 * {@link PlayPlan} (or rejection) and the route's observable write / event /
 * rejection behavior is asserted directly; the write helpers
 * (`writeChallenges`, `writeOffers`, `writeEffects`, `reconcileBarsInTx`,
 * `appendEvent`) run for real against the fake tx, so the recorded rows and
 * events are the ones the route actually issues.
 *
 * The planner's own rule coverage (validation order, resolver families,
 * Legal_Next_Bar) lives in `lib/cards/playPlan.*.property.test.ts`; the live
 * settle function, schema constraints, and RLS live under
 * `supabase/__tests__/integration`.
 *
 * Coverage (the task's named behaviors):
 *   - atomic success per resolver family (challenge, effect, bar effect,
 *     Voted Off) with the expected rows and the embedded `card_played` event;
 *   - write-free rejection per Stable_Error, including Fairest-via-play and the
 *     Pioneer/Scenic `no_legal_next_bar` rejection (card stays in hand);
 *   - a Pioneer/Scenic play whose Fairest mirror is illegal succeeds with no
 *     offer;
 *   - an injected `appendEvent` failure → `unavailable` with no committed rows;
 *   - lazy settle: the settle runs before `loadBehaviorState`, its transition
 *     events precede `card_played`, and a rejection commits no domain rows and
 *     no mutation events (transition events are allowed).
 *
 * Requirements: 9.15, 10.10, 19.5, 19.7, 19.9, 19.10, 24.2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRunner } from "@/lib/events";
import type { PlayPlan } from "@/lib/cards/playPlan";
import type {
  ChallengeRecord,
  EffectRecord,
  FairestOfferRecord,
} from "@/lib/cards/behaviorStore";
import type { StableError } from "@/lib/cards/behaviorState";

// ---------------------------------------------------------------------------
// Fixtures. Bar ids are uuids that are not candidate slugs, so each resolves to
// barKey === barId (no CANDIDATE_BARS coupling) — the same discipline as
// behaviorStore.test.ts.
// ---------------------------------------------------------------------------

const HOST = "host-session-aaaa";
const TEAM_A = "22222222-2222-4222-8222-222222222222";
const TEAM_B = "33333333-3333-4333-8333-333333333333";
const SESSION_A = "session-a";
const START_BAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BAR_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINISH_BAR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2024-01-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// In-memory fake database modelling the pipeline SQL.
// ---------------------------------------------------------------------------

interface ClaimRecordRow {
  claim_id: string;
  team_id: string;
  bar_id: string;
  bar_name: string;
  claimed_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface AppendedEvent {
  seq: number;
  eventType: string;
  actorTeamId: string | null;
  payload: Record<string, unknown>;
}

/**
 * A tiny SQL-shaped store. It does not interpret arbitrary SQL; it recognizes
 * the specific statements the play pipeline issues (matched by a stable
 * substring, lower-cased) and applies them to the in-memory tables. The
 * recognizers mirror the `FakeDb` pattern in `behaviorStore.test.ts`.
 */
class FakeDb {
  /** Game lifecycle the membership + load path reads. */
  lifecycle: "lobby" | "live" | "ended" = "live";
  /** Whether the requester is a member (controls the membership CTE). */
  member = true;
  /** The requester's resolved team (null → no_team). */
  playerTeamId: string | null = TEAM_A;

  readonly bars = [
    { id: START_BAR, name: "Start Place", location: null as string | null },
    { id: BAR_1, name: "Bar One", location: null as string | null },
    { id: FINISH_BAR, name: "Finish Place", location: null as string | null },
  ];
  readonly claims: ClaimRecordRow[] = [];

  /** How many transition events the fake settle function reports appending. */
  settleAppended = 0;
  /** The last transition seq the settle reports (null → none). */
  lastTransitionSeq: number | null = null;

  /** Rows the route wrote, by table, for atomic-success assertions. */
  readonly playRows: Record<string, unknown[]>[] = [];
  readonly challengeRows = new Map<string, Record<string, unknown>>();
  readonly offerRows = new Map<string, Record<string, unknown>>();
  readonly effectRows = new Map<string, Record<string, unknown>>();
  readonly ledgerRows: Record<string, unknown>[] = [];
  readonly revokedClaimIds: string[] = [];
  readonly releasedEffectIds: string[] = [];
  readonly events: AppendedEvent[] = [];

  /** Every SQL statement the route issued, lower-cased, in order. */
  readonly sqlLog: string[] = [];

  /** When set, `appendEvent`'s insert throws to exercise the rollback path. */
  failAppend = false;

  private seq = 0;
  private ledgerSeq = 0;

  readonly runner: QueryRunner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const text = sql.toLowerCase();
      this.sqlLog.push(text);
      return { rows: this.dispatch(text, sql, params) };
    },
  };

  private dispatch(
    text: string,
    sql: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    // --- appendEvent (the game_events CTE insert) FIRST. --------------------
    // Its CTE contains `from games ... for update`, `from game_events`, and
    // `max(seq)`, which would otherwise be captured by the membership /
    // last-transition recognizers below, so it must be matched first.
    if (text.includes("insert into game_events")) {
      if (this.failAppend) {
        throw new Error("injected appendEvent failure");
      }
      const eventType = String(params[1]);
      const actorTeamId = params[3] == null ? null : String(params[3]);
      const payload = JSON.parse(String(params[4])) as Record<string, unknown>;
      this.seq += 1;
      this.events.push({ seq: this.seq, eventType, actorTeamId, payload });
      return [
        {
          id: `evt-${this.seq}`,
          game_id: String(params[0]),
          seq: this.seq,
          event_type: eventType,
          actor_kind: String(params[2]),
          actor_team_id: actorTeamId,
          payload,
          created_at: new Date(this.seq).toISOString(),
        },
      ];
    }

    // --- Pipeline step 1: membership + lifecycle + player resolution. -------
    // MEMBERSHIP_SQL: `... from locked g where g.admin_session_id = ...`.
    if (text.includes("from locked")) {
      return this.member ? [{ ok: 1 }] : [];
    }
    // resolveCardActor lifecycle gate (GAME_LIFECYCLE_SQL): bare `select
    // lifecycle from games`. Must precede the broader `from games` matchers.
    if (text.includes("select lifecycle")) {
      return [{ lifecycle: this.lifecycle }];
    }
    if (text.includes("from players")) {
      return this.playerTeamId === null ? [] : [{ team_id: this.playerTeamId }];
    }

    // --- Pipeline step 2: the server clock. ---------------------------------
    if (text.includes("clock_timestamp()")) {
      return [{ now: NOW }];
    }

    // --- Pipeline step 3: the lazy settle + its last-transition-seq read. ---
    if (text.includes("bbb_settle_card_effects")) {
      return [{ appended: this.settleAppended }];
    }
    if (text.includes("from game_events") && text.includes("max(seq)")) {
      return [{ last_seq: this.lastTransitionSeq }];
    }

    // --- Pipeline step 4: loadBehaviorState + resolveGameBar SELECTs. -------
    // behaviorStore GAME_SQL (lifecycle + designations).
    if (text.includes("from games") && text.includes("lifecycle")) {
      return [
        {
          lifecycle: this.lifecycle,
          admin_session_id: HOST,
          start_bar_id: START_BAR,
          finish_bar_id: FINISH_BAR,
        },
      ];
    }
    // resolveGameBar GAME_BARS_SQL (designations only).
    if (text.includes("from games")) {
      return [{ start_bar_id: START_BAR, finish_bar_id: FINISH_BAR }];
    }
    if (text.includes("from bars")) {
      return this.bars.map((b) => ({
        id: b.id,
        name: b.name,
        location: b.location,
      }));
    }
    if (text.includes("from teams")) {
      return [
        { team_id: TEAM_A, name: "Alpha", member_session_ids: [SESSION_A] },
        { team_id: TEAM_B, name: "Bravo", member_session_ids: ["s-b1"] },
      ];
    }
    if (text.includes("from claims")) {
      return this.claims.map((c) => ({ ...c }));
    }
    if (text.includes("from card_instances")) {
      return [];
    }
    if (text.includes("from card_plays")) {
      return [];
    }
    if (text.includes("from card_challenges")) {
      return [...this.challengeRows.values()].map((r) => ({ ...r }));
    }
    if (text.includes("from fairest_offers")) {
      return [...this.offerRows.values()].map((r) => ({ ...r }));
    }
    if (text.includes("from card_effects e")) {
      return [...this.effectRows.values()].map((r) => ({
        ...r,
        attached_bar_name: null,
      }));
    }
    if (text.includes("from card_effect_awards")) {
      return [];
    }
    if (text.includes("from score_ledger_entries")) {
      return this.ledgerRows.map((l) => ({ ...l }));
    }

    // --- Writes (pipeline steps 7-8). ---------------------------------------
    if (text.includes("insert into card_plays")) {
      this.playRows.push({ params: [...params] });
      return [];
    }
    if (text.includes("insert into card_challenges")) {
      const id = String(params[0]);
      this.challengeRows.set(id, {
        id,
        slug: params[3],
        source_play_id: params[2],
        caster_team_id: params[4],
        target_team_id: params[5],
        params: JSON.parse(String(params[6])),
        status: params[9],
        created_at: params[10],
      });
      return [];
    }
    if (text.includes("insert into fairest_offers")) {
      const id = String(params[0]);
      this.offerRows.set(id, {
        id,
        source_play_id: params[2],
        slug: params[3],
        holder_team_id: params[4],
        original_caster_team_id: params[5],
        challenge_id: params[6] ?? null,
        restriction_effect_id: params[7] ?? null,
        status: params[8],
      });
      return [];
    }
    if (text.includes("insert into card_effects")) {
      const id = String(params[0]);
      this.effectRows.set(id, {
        id,
        slug: params[4],
        kind: params[5],
        owner_team_id: params[6] ?? null,
        target_bar_key: params[9] ?? null,
        starts_at: params[10],
        ends_at: params[11] ?? null,
      });
      return [];
    }
    if (text.includes("set revoked_at = now(), revoked_reason = 'voted_off'")) {
      // REVOKE_CLAIM_VOTED_OFF_SQL: $1 claimId, $2 gameId. Returns the row id
      // when a matching, un-revoked claim exists.
      const claimId = String(params[0]);
      const claim = this.claims.find(
        (c) => c.claim_id === claimId && c.revoked_at === null,
      );
      if (claim === undefined) return [];
      claim.revoked_at = NOW;
      claim.revoked_reason = "voted_off";
      this.revokedClaimIds.push(claimId);
      return [{ id: claimId }];
    }
    if (text.includes("cancel_reason = 'protection_released'")) {
      this.releasedEffectIds.push(String(params[0]));
      return [];
    }
    if (text.includes("insert into score_ledger_entries")) {
      this.ledgerSeq += 1;
      const id = `ledger-${this.ledgerSeq}`;
      this.ledgerRows.push({
        id,
        team_id: params[1],
        bar_id: params[2] == null ? null : String(params[2]),
        category: params[5],
        points: Number(params[6]),
        source_claim_id: params[3] ?? null,
        source_effect_id: params[4] ?? null,
      });
      return [{ id }];
    }

    throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 60)}`);
  }

  /** The index of the first SQL statement matching `substring` (or -1). */
  firstSqlIndex(substring: string): number {
    return this.sqlLog.findIndex((s) => s.includes(substring));
  }

  /** The total domain rows this run wrote, excluding events. */
  domainRowCount(): number {
    return (
      this.playRows.length +
      this.challengeRows.size +
      this.offerRows.size +
      this.effectRows.size +
      this.ledgerRows.length +
      this.revokedClaimIds.length +
      this.releasedEffectIds.length
    );
  }
}

// ---------------------------------------------------------------------------
// Mocks: the transaction wrapper runs against the active fake db; the pure
// planner is mocked so each test drives one crafted plan or rejection.
// ---------------------------------------------------------------------------

let db: FakeDb;

vi.mock("@/lib/db/server", () => ({
  withTransaction: async <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    fn(db.runner),
}));

const planCardPlay = vi.fn();
vi.mock("@/lib/cards/playPlan", () => ({
  planCardPlay: (...args: unknown[]) => planCardPlay(...args),
}));

// The deck transition is the caster's own hand change; the planner already
// validated the card is in hand, so the default is a successful removal. A test
// can override it to the disagree-with-snapshot (`conflict`) path.
let deckTransitionOk = true;
vi.mock("@/lib/cards/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/cards/persistence")
  >("@/lib/cards/persistence");
  return {
    ...actual,
    applyDeckRowsOnly: vi.fn(async () =>
      deckTransitionOk
        ? { ok: true, state: {}, records: [] }
        : { ok: false, reason: "card_not_in_hand", state: {} },
    ),
  };
});

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Plan builders. The route only reads the plan's record lists, slug, params,
// and target bar, so these are minimal, valid-shaped PlayPlans.
// ---------------------------------------------------------------------------

function emptyPlan(overrides: Partial<PlayPlan> = {}): PlayPlan {
  return {
    slug: "go-piss-girl",
    params: { kind: "none" },
    targetBar: null,
    challenges: [],
    offers: [],
    effects: [],
    revokeClaims: [],
    releaseProtections: [],
    reconcileBars: [],
    inventoryFollowUp: { completeChallenges: [], voidOffers: [] },
    ...overrides,
  };
}

function challengeRecord(
  overrides: Partial<ChallengeRecord> = {},
): ChallengeRecord {
  return {
    challengeId: "chal-1",
    slug: "go-piss-girl",
    sourcePlayId: "play-1",
    casterTeamId: TEAM_A,
    targetTeamId: TEAM_B,
    params: { kind: "none" } as ChallengeRecord["params"],
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status: "open",
    createdAt: NOW,
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
    ...overrides,
  };
}

function offerRecord(
  overrides: Partial<FairestOfferRecord> = {},
): FairestOfferRecord {
  return {
    offerId: "offer-1",
    sourcePlayId: "play-1",
    slug: "pioneer",
    holderTeamId: TEAM_B,
    originalCasterTeamId: TEAM_A,
    challengeId: null,
    restrictionEffectId: "eff-restrict-1",
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
    ...overrides,
  };
}

function effectRecord(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    effectId: "eff-1",
    slug: "crop-dusting",
    kind: "bar_lock",
    sourcePlayId: "play-1",
    sourceChallengeId: null,
    ownerTeamId: TEAM_A,
    targetTeamId: null,
    targetBarKey: BAR_1,
    startsAt: NOW,
    endsAt: "2024-01-01T12:15:00.000Z",
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

function okPlan(plan: PlayPlan): void {
  planCardPlay.mockReturnValue({ ok: true, plan });
}

function rejectPlan(error: StableError, details?: unknown): void {
  planCardPlay.mockReturnValue(
    details === undefined
      ? { ok: false, error }
      : { ok: false, error, details },
  );
}

// ---------------------------------------------------------------------------
// Request helpers.
// ---------------------------------------------------------------------------

function request(body: unknown, sessionId: string | null = SESSION_A): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sessionId !== null) headers["x-bbb-session-id"] = sessionId;
  return new Request("http://test/api/games/game-1/cards/play", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function params(): { params: Promise<{ gameId: string }> } {
  return { params: Promise.resolve({ gameId: "game-1" }) };
}

function activeClaim(
  claimId: string,
  teamId: string,
  barId: string,
): ClaimRecordRow {
  return {
    claim_id: claimId,
    team_id: teamId,
    bar_id: barId,
    bar_name: "Bar One",
    claimed_at: "2024-01-01T11:00:00.000Z",
    revoked_at: null,
    revoked_reason: null,
  };
}

beforeEach(() => {
  db = new FakeDb();
  planCardPlay.mockReset();
  deckTransitionOk = true;
});

// ---------------------------------------------------------------------------
// Atomic success per resolver family.
// ---------------------------------------------------------------------------

describe("POST card/play: atomic success per resolver family", () => {
  it("a gated team challenge writes card_plays + the challenge and embeds it in card_played", async () => {
    okPlan(
      emptyPlan({
        slug: "go-piss-girl",
        challenges: [challengeRecord()],
      }),
    );

    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 1 });

    // Rows: one card_plays row and one challenge row.
    expect(db.playRows).toHaveLength(1);
    expect(db.challengeRows.size).toBe(1);
    expect(db.effectRows.size).toBe(0);

    // Exactly one mutation event, carrying the embedded challenge.
    expect(db.events).toHaveLength(1);
    const played = db.events[0];
    expect(played.eventType).toBe("card_played");
    expect(played.actorTeamId).toBe(TEAM_A);
    expect(played.payload.slug).toBe("go-piss-girl");
    expect(played.payload.targetTeamId).toBe(TEAM_B);
    expect(
      (played.payload.challenges as { challengeId: string }[])[0].challengeId,
    ).toBe("chal-1");
  });

  it("a self-targeting effect card (Insurance) writes one effect and embeds it", async () => {
    okPlan(
      emptyPlan({
        slug: "insurance",
        effects: [
          effectRecord({
            effectId: "eff-ins",
            slug: "insurance",
            kind: "score_protection",
            targetBarKey: null,
            endsAt: null,
          }),
        ],
      }),
    );

    const response = await POST(
      request({ cardId: `${TEAM_A}:insurance` }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(db.effectRows.size).toBe(1);
    expect(db.effectRows.get("eff-ins")?.kind).toBe("score_protection");
    expect(db.events).toHaveLength(1);
    expect(
      (db.events[0].payload.effects as { effectId: string }[])[0].effectId,
    ).toBe("eff-ins");
  });

  it("a bar-targeting effect card (Crop Dusting) persists the resolved bar id on the effect row", async () => {
    okPlan(
      emptyPlan({
        slug: "crop-dusting",
        targetBar: { barKey: BAR_1, kind: "scoring", coords: null },
        effects: [effectRecord()],
      }),
    );

    const response = await POST(
      request({ cardId: `${TEAM_A}:crop-dusting`, targetBarId: BAR_1 }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(db.effectRows.get("eff-1")?.target_bar_key).toBe(BAR_1);
    // The card_plays row carries the resolved target bar id (BAR_1 resolves to
    // itself since it is a uuid, not a candidate slug).
    const playParams = db.playRows[0].params as unknown[];
    expect(playParams[6]).toBe(BAR_1); // target_bar_id
    expect(playParams[7]).toBe(BAR_1); // target_bar_key
  });

  it("Voted Off revokes the target claim, reconciles, and appends claim_removed as the last mutation event", async () => {
    db.claims.push(activeClaim("claim-victim", TEAM_B, BAR_1));
    okPlan(
      emptyPlan({
        slug: "voted-off-the-island",
        targetBar: { barKey: BAR_1, kind: "scoring", coords: null },
        revokeClaims: [{ claimId: "claim-victim", reason: "voted_off" }],
        reconcileBars: [BAR_1],
      }),
    );

    const response = await POST(
      request({
        cardId: `${TEAM_A}:voted-off-the-island`,
        targetTeamId: TEAM_B,
        targetBarId: BAR_1,
      }),
      params(),
    );

    expect(response.status).toBe(200);
    // The claim was revoked with the voted_off reason.
    expect(db.revokedClaimIds).toEqual(["claim-victim"]);
    // Two mutation events: card_played then the trailing claim_removed; the
    // response seq is the LAST (claim_removed).
    expect(db.events.map((e) => e.eventType)).toEqual([
      "card_played",
      "claim_removed",
    ]);
    await expect(response.json()).resolves.toEqual({ applied: true, seq: 2 });
    const removed = db.events[1];
    expect(removed.payload.claimId).toBe("claim-victim");
    expect(removed.payload.reason).toBe("voted_off");
  });
});

// ---------------------------------------------------------------------------
// Write-free rejection per Stable_Error.
// ---------------------------------------------------------------------------

describe("POST card/play: write-free rejection", () => {
  it("rejects a missing session (401) and writes nothing", async () => {
    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl` }, null),
      params(),
    );
    expect(response.status).toBe(401);
    expect(planCardPlay).not.toHaveBeenCalled();
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
  });

  it("rejects a non-member (403) before planning and writes nothing", async () => {
    db.member = false;
    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );
    expect(response.status).toBe(403);
    expect(planCardPlay).not.toHaveBeenCalled();
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
  });

  it("maps a not-live game to conflict (409) with no writes", async () => {
    // resolveCardActor rejects a non-live game as not_live → conflict.
    db.lifecycle = "ended";
    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      applied: false,
      error: "conflict",
    });
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
  });

  it("maps a planner conflict (card not in hand) to 409 with no writes", async () => {
    rejectPlan("conflict");
    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
  });

  it("maps a planner invalid_input to 400 with no writes (Fairest via play)", async () => {
    // Fairest of Them All played as a normal play is rejected invalid_input.
    rejectPlan("invalid_input");
    const response = await POST(
      request({ cardId: `${TEAM_A}:fairest-of-them-all` }),
      params(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_input",
    });
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
  });

  it("relays the Pioneer/Scenic no_legal_next_bar rejection and leaves the card in hand", async () => {
    rejectPlan("invalid_input", {
      reason: "no_legal_next_bar",
      rules: ["pioneer"],
    });
    const response = await POST(
      request({ cardId: `${TEAM_A}:pioneer`, targetTeamId: TEAM_B }),
      params(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "invalid_input",
      details: { reason: "no_legal_next_bar", rules: ["pioneer"] },
    });
    // The card stays in hand: no deck transition, no rows, no mutation event.
    expect(db.domainRowCount()).toBe(0);
    expect(db.events).toHaveLength(0);
    expect(db.firstSqlIndex("insert into card_plays")).toBe(-1);
  });

  it("maps a deck transition that disagrees with the snapshot to conflict and rolls back", async () => {
    // The planner accepted the play, but the loaded deck disagrees that the
    // card is in hand, so the deck transition rejects → conflict, roll back.
    okPlan(emptyPlan({ challenges: [challengeRecord()] }));
    deckTransitionOk = false;

    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "conflict",
    });
    // No mutation event appended (the transaction rolls back on the caller).
    expect(db.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pioneer/Scenic play with an illegal mirror succeeds with no offer.
// ---------------------------------------------------------------------------

describe("POST card/play: Pioneer/Scenic illegal mirror", () => {
  it("writes the restriction effect but no Fairest offer when the mirror is illegal", async () => {
    // The planner, having found mirrorIsLegal false, returns the restriction
    // with an empty offers list; the play still succeeds.
    okPlan(
      emptyPlan({
        slug: "pioneer",
        effects: [
          effectRecord({
            effectId: "eff-restrict",
            slug: "pioneer",
            kind: "next_claim_restriction",
            targetTeamId: TEAM_B,
            targetBarKey: null,
            endsAt: null,
            params: { rule: "pioneer" },
          }),
        ],
        offers: [],
      }),
    );

    const response = await POST(
      request({ cardId: `${TEAM_A}:pioneer`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(db.effectRows.size).toBe(1);
    // No Fairest offer row written.
    expect(db.offerRows.size).toBe(0);
    expect(db.events).toHaveLength(1);
    expect((db.events[0].payload.offers as unknown[]).length).toBe(0);
  });

  it("writes the Fairest offer when the mirror is legal", async () => {
    okPlan(
      emptyPlan({
        slug: "pioneer",
        effects: [
          effectRecord({
            effectId: "eff-restrict",
            slug: "pioneer",
            kind: "next_claim_restriction",
            targetTeamId: TEAM_B,
            targetBarKey: null,
            endsAt: null,
            params: { rule: "pioneer" },
          }),
        ],
        offers: [offerRecord({ restrictionEffectId: "eff-restrict" })],
      }),
    );

    const response = await POST(
      request({ cardId: `${TEAM_A}:pioneer`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(db.offerRows.size).toBe(1);
    expect(db.offerRows.get("offer-1")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Injected append failure → unavailable with no rows.
// ---------------------------------------------------------------------------

describe("POST card/play: append failure", () => {
  it("responds unavailable (503) and commits no mutation event when appendEvent throws", async () => {
    okPlan(emptyPlan({ challenges: [challengeRecord()] }));
    db.failAppend = true;

    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      applied: false,
      error: "unavailable",
    });
    // The throw aborts before any mutation event is recorded; the caller's
    // transaction rolls the domain rows back with it.
    expect(db.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lazy settle ordering (pipeline step 3).
// ---------------------------------------------------------------------------

describe("POST card/play: lazy settle ordering", () => {
  it("runs the settle before loadBehaviorState", async () => {
    okPlan(emptyPlan({ challenges: [challengeRecord()] }));

    await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    const settleIdx = db.firstSqlIndex("bbb_settle_card_effects");
    // The first loadBehaviorState SELECT is GAME_SQL, uniquely identified by its
    // `lifecycle, admin_session_id` projection (the membership CTE references
    // `admin_session_id` alone, so match the pair).
    const loadIdx = db.firstSqlIndex("lifecycle, admin_session_id");
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeLessThan(loadIdx);
  });

  it("orders settle transition events before the mutation's card_played", async () => {
    // A due-transition fixture: the settle reports it appended one transition
    // event (effect_activated) with seq 7 before the mutation runs. The route's
    // own card_played must come after.
    db.settleAppended = 1;
    db.lastTransitionSeq = 7;
    // Pre-seed the transition event the settle "appended" so the log reflects
    // reality: the mutation's card_played is appended after it.
    db.events.push({
      seq: 7,
      eventType: "effect_activated",
      actorTeamId: null,
      payload: {},
    });

    okPlan(emptyPlan({ challenges: [challengeRecord()] }));

    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(200);
    // The transition event precedes the mutation event in the log.
    const transitionIdx = db.events.findIndex(
      (e) => e.eventType === "effect_activated",
    );
    const playedIdx = db.events.findIndex((e) => e.eventType === "card_played");
    expect(transitionIdx).toBeGreaterThanOrEqual(0);
    expect(playedIdx).toBeGreaterThan(transitionIdx);
  });

  it("commits no domain rows and no mutation event on rejection, but allows the settle transition events", async () => {
    // The settle appended a transition event; the mutation is then rejected.
    db.settleAppended = 1;
    db.lastTransitionSeq = 7;
    db.events.push({
      seq: 7,
      eventType: "effect_expired",
      actorTeamId: null,
      payload: {},
    });
    rejectPlan("conflict");

    const response = await POST(
      request({ cardId: `${TEAM_A}:go-piss-girl`, targetTeamId: TEAM_B }),
      params(),
    );

    expect(response.status).toBe(409);
    // No domain rows and no mutation event.
    expect(db.domainRowCount()).toBe(0);
    expect(db.events.some((e) => e.eventType === "card_played")).toBe(false);
    // The transition event the settle appended is still present (allowed).
    expect(db.events.some((e) => e.eventType === "effect_expired")).toBe(true);
    // The settle still ran before the planner saw the loaded state.
    expect(db.firstSqlIndex("bbb_settle_card_effects")).toBeGreaterThanOrEqual(
      0,
    );
  });
});
