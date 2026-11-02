/**
 * Card-behavior persistence helper (`lib/cards/behaviorStore.ts`) — hermetic
 * unit tests (task 6.6).
 *
 * These tests exercise the load / write / reconcile / cancel contract against an
 * in-memory fake {@link QueryRunner} that recognizes the specific statements the
 * store issues (matched by a stable SQL substring) and applies them to in-memory
 * tables, in the same style as `lib/cards/persistence.test.ts`'s `FakeDb`. No
 * live Postgres is required, so this runs in the default hermetic suite; the live
 * schema (0013 constraints, RLS, the settle function) is covered by the
 * integration suite under `supabase/__tests__/integration`.
 *
 * Coverage:
 *   - loadBehaviorState assembles the correct BehaviorState shape from the
 *     recognized SELECTs (teams, bars, claims active vs. history, hands, plays,
 *     challenges, offers, effects, awards, ledger).
 *   - the write helpers issue idempotent `on conflict (id) do update` upserts, so
 *     re-running the same plan in a transaction converges.
 *   - reconcileBarsInTx appends the minimal ledger diff, honoring the Party
 *     Crasher phantom and Insurance protected floors.
 *   - endGameEffects issues the `game_ended` cancellation update over every live
 *     effect.
 *
 * Requirements: 19.4, 20.6.
 */

import { describe, expect, it } from "vitest";

import type { QueryRunner } from "@/lib/events";

import {
  endGameEffects,
  loadBehaviorState,
  reconcileBarsInTx,
  writeChallenges,
  writeEffects,
  writeOffers,
  type AllocationOverrides,
  type BehaviorState,
  type ChallengeRecord,
  type EffectRecord,
  type FairestOfferRecord,
} from "./behaviorStore";

// ---------------------------------------------------------------------------
// In-memory fake database
// ---------------------------------------------------------------------------

interface GameRow {
  id: string;
  lifecycle: string;
  admin_session_id: string;
  start_bar_id: string | null;
  finish_bar_id: string | null;
}

interface BarRow {
  id: string;
  name: string;
  location: string | null;
}

interface TeamRow {
  team_id: string;
  name: string;
  member_session_ids: string[];
}

interface ClaimRecordRow {
  claim_id: string;
  team_id: string;
  bar_id: string;
  bar_name: string;
  claimed_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface InstanceRow {
  owner_team_id: string;
  slug: string;
  deck_state: string | null;
  draw_position: number;
}

interface LedgerRow {
  id: string;
  team_id: string;
  bar_id: string | null;
  category: string;
  points: number;
  source_claim_id: string | null;
  source_effect_id: string | null;
  metadata: Record<string, unknown>;
}

/** A persisted row with its upsert `set` fields separated for idempotency. */
interface StoredChallenge extends Record<string, unknown> {
  id: string;
}
interface StoredOffer extends Record<string, unknown> {
  id: string;
}
interface StoredEffect extends Record<string, unknown> {
  id: string;
}

/**
 * A tiny SQL-shaped store. It does not interpret arbitrary SQL; it recognizes
 * the specific statements `behaviorStore.ts` (and `resolveGameBar`) issue — each
 * matched by a stable substring — and applies them to the in-memory tables. The
 * recognizers mirror the `FakeDb` pattern in `persistence.test.ts`.
 */
class FakeDb {
  game: GameRow;
  readonly bars: BarRow[] = [];
  readonly teams: TeamRow[] = [];
  readonly claims: ClaimRecordRow[] = [];
  readonly instances: InstanceRow[] = [];
  readonly plays: Record<string, unknown>[] = [];
  readonly challenges = new Map<string, StoredChallenge>();
  readonly offers = new Map<string, StoredOffer>();
  readonly effects = new Map<string, StoredEffect>();
  readonly awards: Record<string, unknown>[] = [];
  readonly ledger: LedgerRow[] = [];
  /** Count of statements per recognizer, so a test can assert idempotency. */
  readonly sqlCalls: string[] = [];
  private ledgerSeq = 0;
  private createdSeq = 0;

  constructor(game: GameRow) {
    this.game = game;
  }

  readonly runner: QueryRunner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      this.sqlCalls.push(sql);
      return { rows: this.dispatch(sql, params) };
    },
  };

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    // --- behaviorStore GAME_SQL (lifecycle + designations). -----------------
    if (sql.includes("from games") && sql.includes("lifecycle")) {
      if (String(params[0]) !== this.game.id) return [];
      return [
        {
          lifecycle: this.game.lifecycle,
          admin_session_id: this.game.admin_session_id,
          start_bar_id: this.game.start_bar_id,
          finish_bar_id: this.game.finish_bar_id,
        },
      ];
    }
    // --- resolveGameBar GAME_BARS_SQL (designations only). ------------------
    if (sql.includes("from games")) {
      return [
        {
          start_bar_id: this.game.start_bar_id,
          finish_bar_id: this.game.finish_bar_id,
        },
      ];
    }
    // --- bars (behaviorStore BARS_SQL and resolver BAR_ROWS_SQL). -----------
    if (sql.includes("from bars")) {
      return this.bars.map((b) => ({
        id: b.id,
        name: b.name,
        location: b.location,
      }));
    }
    // --- teams with aggregated member sessions. -----------------------------
    if (sql.includes("from teams")) {
      return this.teams.map((t) => ({
        team_id: t.team_id,
        name: t.name,
        member_session_ids: t.member_session_ids,
      }));
    }
    // --- claims joined to bars. ---------------------------------------------
    if (sql.includes("from claims")) {
      return this.claims.map((c) => ({
        claim_id: c.claim_id,
        team_id: c.team_id,
        bar_id: c.bar_id,
        bar_name: c.bar_name,
        claimed_at: c.claimed_at,
        revoked_at: c.revoked_at,
        revoked_reason: c.revoked_reason,
      }));
    }
    // --- card instances joined to definitions. ------------------------------
    if (sql.includes("from card_instances")) {
      return this.instances.map((i) => ({
        owner_team_id: i.owner_team_id,
        slug: i.slug,
        deck_state: i.deck_state,
        draw_position: i.draw_position,
      }));
    }
    // --- plays, challenges, offers, effects, awards, ledger (SELECTs). ------
    if (sql.includes("from card_plays")) {
      return this.plays.map((p) => ({ ...p }));
    }
    if (sql.includes("from card_challenges") && sql.startsWith("\nselect")) {
      return [...this.challenges.values()].map((r) => ({ ...r }));
    }
    if (sql.includes("from fairest_offers") && sql.startsWith("\nselect")) {
      return [...this.offers.values()].map((r) => ({ ...r }));
    }
    if (sql.includes("from card_effects e")) {
      return [...this.effects.values()].map((r) => ({
        ...r,
        attached_bar_name: null,
      }));
    }
    if (sql.includes("from card_effect_awards")) {
      return this.awards.map((a) => ({ ...a }));
    }
    if (sql.includes("from score_ledger_entries")) {
      return this.ledger.map((l) => ({
        id: l.id,
        team_id: l.team_id,
        bar_id: l.bar_id,
        category: l.category,
        points: l.points,
        source_claim_id: l.source_claim_id,
        source_effect_id: l.source_effect_id,
      }));
    }

    // --- UPSERTs (idempotent on conflict (id) do update). -------------------
    if (sql.includes("insert into card_challenges")) {
      const id = String(params[0]);
      this.challenges.set(id, {
        id,
        slug: params[3],
        source_play_id: params[2],
        caster_team_id: params[4],
        target_team_id: params[5],
        params: JSON.parse(String(params[6])),
        mirrored_from_challenge_id: params[7] ?? null,
        mirrored_from_play_id: params[8] ?? null,
        status: params[9],
        created_at: params[10],
        resolved_at: params[11] ?? null,
        resolved_by_kind: params[12] ?? null,
        resolved_by_team_id: params[13] ?? null,
        resolved_by_session_id: params[14] ?? null,
        failure_effect_id: params[15] ?? null,
      });
      return [];
    }
    if (sql.includes("insert into fairest_offers")) {
      const id = String(params[0]);
      this.offers.set(id, {
        id,
        source_play_id: params[2],
        slug: params[3],
        holder_team_id: params[4],
        original_caster_team_id: params[5],
        challenge_id: params[6] ?? null,
        restriction_effect_id: params[7] ?? null,
        status: params[8],
        decided_at: params[10] ?? null,
        mirrored_challenge_id: params[11] ?? null,
        mirrored_effect_id: params[12] ?? null,
      });
      return [];
    }
    if (sql.includes("insert into card_effects")) {
      const id = String(params[0]);
      this.effects.set(id, {
        id,
        slug: params[4],
        kind: params[5],
        source_play_id: params[2] ?? null,
        source_challenge_id: params[3] ?? null,
        owner_team_id: params[6] ?? null,
        target_team_id: params[7] ?? null,
        target_bar_id: params[8] ?? null,
        target_bar_key: params[9] ?? null,
        starts_at: params[10],
        ends_at: params[11] ?? null,
        params: JSON.parse(String(params[12])),
        attached_claim_id: params[13] ?? null,
        attached_bar_id: params[14] ?? null,
        protected_points: params[15] ?? null,
        consumed_at: params[16] ?? null,
        cancelled_at: params[18] ?? null,
        cancel_reason: params[19] ?? null,
        start_announced_at: params[20] ?? null,
        end_announced_at: params[21] ?? null,
      });
      return [];
    }

    // --- ledger append (server-generated id). -------------------------------
    if (sql.includes("insert into score_ledger_entries")) {
      this.ledgerSeq += 1;
      const id = `ledger-${this.ledgerSeq}`;
      this.ledger.push({
        id,
        team_id: String(params[1]),
        bar_id: params[2] == null ? null : String(params[2]),
        source_claim_id: params[3] == null ? null : String(params[3]),
        source_effect_id: params[4] == null ? null : String(params[4]),
        category: String(params[5]),
        points: Number(params[6]),
        metadata: JSON.parse(String(params[7])),
      });
      return [{ id }];
    }

    // --- end-of-game cancellation. ------------------------------------------
    if (sql.includes("update card_effects") && sql.includes("'game_ended'")) {
      for (const [id, row] of this.effects) {
        if (row.cancelled_at == null && row.consumed_at == null) {
          this.effects.set(id, {
            ...row,
            cancelled_at: `cancelled-${++this.createdSeq}`,
            cancel_reason: "game_ended",
          });
        }
      }
      return [];
    }

    throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 60)}`);
  }

  /** How many statements matched a recognizer substring (for idempotency). */
  countSql(substring: string): number {
    return this.sqlCalls.filter((s) => s.includes(substring)).length;
  }
}

// ---------------------------------------------------------------------------
// Fixtures. Bar ids are uuids that are not candidate slugs, so each resolves to
// barKey === barId (no CANDIDATE_BARS coupling).
// ---------------------------------------------------------------------------

const GAME = "11111111-1111-4111-8111-111111111111";
const HOST = "host-session-aaaa";
const TEAM_A = "22222222-2222-4222-8222-222222222222";
const TEAM_B = "33333333-3333-4333-8333-333333333333";
const START_BAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BAR_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINISH_BAR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2024-01-01T12:00:00.000Z";

function freshDb(): FakeDb {
  const db = new FakeDb({
    id: GAME,
    lifecycle: "live",
    admin_session_id: HOST,
    start_bar_id: START_BAR,
    finish_bar_id: FINISH_BAR,
  });
  db.bars.push(
    { id: START_BAR, name: "Start Place", location: null },
    { id: BAR_1, name: "Bar One", location: null },
    { id: FINISH_BAR, name: "Finish Place", location: null },
  );
  db.teams.push(
    { team_id: TEAM_A, name: "Alpha", member_session_ids: ["s-a1", "s-a2"] },
    { team_id: TEAM_B, name: "Bravo", member_session_ids: ["s-b1"] },
  );
  return db;
}

// ---------------------------------------------------------------------------
// loadBehaviorState — shape assembly (R19.4).
// ---------------------------------------------------------------------------

describe("loadBehaviorState: snapshot assembly (R19.4)", () => {
  it("assembles lifecycle, host, teams, bars, and designations", async () => {
    const db = freshDb();
    const state = await loadBehaviorState(db.runner, GAME, NOW);

    expect(state.gameId).toBe(GAME);
    expect(state.lifecycle).toBe("live");
    expect(state.nowIso).toBe(NOW);
    expect(state.hostSessionId).toBe(HOST);

    expect(state.teams).toEqual([
      { teamId: TEAM_A, name: "Alpha", memberSessionIds: ["s-a1", "s-a2"] },
      { teamId: TEAM_B, name: "Bravo", memberSessionIds: ["s-b1"] },
    ]);

    // Bars are keyed by their board-facing key; non-candidate uuids key by id.
    expect([...state.bars.keys()].sort()).toEqual(
      [START_BAR, BAR_1, FINISH_BAR].sort(),
    );
    expect(state.startBarKey).toBe(START_BAR);
    expect(state.finishBarKey).toBe(FINISH_BAR);
  });

  it("throws when the game row is missing", async () => {
    const db = freshDb();
    await expect(
      loadBehaviorState(db.runner, "no-such-game", NOW),
    ).rejects.toThrow(/game .* not found/);
  });

  it("splits claims into active and history by revoked_at", async () => {
    const db = freshDb();
    db.claims.push(
      {
        claim_id: "claim-active",
        team_id: TEAM_A,
        bar_id: BAR_1,
        bar_name: "Bar One",
        claimed_at: "2024-01-01T11:00:00.000Z",
        revoked_at: null,
        revoked_reason: null,
      },
      {
        claim_id: "claim-revoked",
        team_id: TEAM_B,
        bar_id: BAR_1,
        bar_name: "Bar One",
        claimed_at: "2024-01-01T11:05:00.000Z",
        revoked_at: "2024-01-01T11:30:00.000Z",
        revoked_reason: "voted_off",
      },
    );

    const state = await loadBehaviorState(db.runner, GAME, NOW);

    // History carries both; active carries only the un-revoked claim.
    expect(state.claimHistory.map((c) => c.claimId)).toEqual([
      "claim-active",
      "claim-revoked",
    ]);
    expect(state.activeClaims.map((c) => c.claimId)).toEqual(["claim-active"]);
    expect(state.claimHistory[1].revokedReason).toBe("voted_off");
    // barKey lines up with the resolved bar key (the uuid here).
    expect(state.activeClaims[0].barKey).toBe(BAR_1);
  });

  it("groups card instances into per-team hand and pending, ignoring deck", async () => {
    const db = freshDb();
    db.instances.push(
      {
        owner_team_id: TEAM_A,
        slug: "go-piss-girl",
        deck_state: "hand",
        draw_position: 0,
      },
      {
        owner_team_id: TEAM_A,
        slug: "moneybags",
        deck_state: "pending",
        draw_position: 1,
      },
      {
        owner_team_id: TEAM_A,
        slug: "wired",
        deck_state: "deck",
        draw_position: 2,
      },
      {
        owner_team_id: TEAM_B,
        slug: "insurance",
        deck_state: "hand",
        draw_position: 0,
      },
    );

    const state = await loadBehaviorState(db.runner, GAME, NOW);

    const a = state.hands.get(TEAM_A);
    expect(a?.hand.map((c) => c.slug)).toEqual(["go-piss-girl"]);
    expect(a?.pending.map((c) => c.slug)).toEqual(["moneybags"]);
    // Deck-state cards never populate the hand snapshot.
    expect(a?.hand.length).toBe(1);
    expect(a?.pending.length).toBe(1);
    // Engine card ids are the stable `${teamId}:${slug}` form.
    expect(a?.hand[0].id).toBe(`${TEAM_A}:go-piss-girl`);

    const b = state.hands.get(TEAM_B);
    expect(b?.hand.map((c) => c.slug)).toEqual(["insurance"]);
    expect(b?.pending).toEqual([]);
  });

  it("maps plays, challenges, offers, effects, awards, and ledger rows", async () => {
    const db = freshDb();
    db.plays.push({
      play_id: "play-1",
      slug: "go-piss-girl",
      caster_team_id: TEAM_A,
      target_team_id: TEAM_B,
      target_bar_id: null,
      target_bar_key: null,
      params: { kind: "none" },
      created_at: "2024-01-01T11:10:00.000Z",
    });
    db.challenges.set("chal-1", {
      id: "chal-1",
      slug: "go-piss-girl",
      source_play_id: "play-1",
      caster_team_id: TEAM_A,
      target_team_id: TEAM_B,
      params: { kind: "none" },
      mirrored_from_challenge_id: null,
      mirrored_from_play_id: null,
      status: "open",
      created_at: "2024-01-01T11:10:00.000Z",
      resolved_at: null,
      resolved_by_kind: null,
      resolved_by_team_id: null,
      resolved_by_session_id: null,
      failure_effect_id: null,
    });
    db.offers.set("offer-1", {
      id: "offer-1",
      source_play_id: "play-1",
      slug: "fairest-of-them-all",
      holder_team_id: TEAM_B,
      original_caster_team_id: TEAM_A,
      challenge_id: "chal-1",
      restriction_effect_id: null,
      status: "pending",
      decided_at: null,
      mirrored_challenge_id: null,
      mirrored_effect_id: null,
    });
    db.effects.set("eff-1", {
      id: "eff-1",
      slug: "crop-dusting",
      kind: "bar_lock",
      source_play_id: "play-1",
      source_challenge_id: null,
      owner_team_id: TEAM_A,
      target_team_id: null,
      target_bar_id: BAR_1,
      target_bar_key: BAR_1,
      starts_at: "2024-01-01T11:10:00.000Z",
      ends_at: "2024-01-01T11:25:00.000Z",
      params: {},
      attached_claim_id: null,
      attached_bar_id: null,
      protected_points: null,
      consumed_at: null,
      cancelled_at: null,
      cancel_reason: null,
      start_announced_at: "2024-01-01T11:10:00.000Z",
      end_announced_at: null,
    });
    db.awards.push({
      id: "award-1",
      effect_id: "eff-2",
      team_id: TEAM_A,
      kind: "happy_hour_bonus",
      claim_id: "claim-x",
      ledger_entry_id: "ledger-x",
      reversed_at: null,
      reversal_ledger_entry_id: null,
      created_at: "2024-01-01T11:15:00.000Z",
    });
    db.ledger.push({
      id: "ledger-x",
      team_id: TEAM_A,
      bar_id: BAR_1,
      category: "bar_share",
      points: 12,
      source_claim_id: "claim-x",
      source_effect_id: null,
      metadata: {},
    });

    const state = await loadBehaviorState(db.runner, GAME, NOW);

    expect(state.plays).toHaveLength(1);
    expect(state.plays[0].playId).toBe("play-1");
    expect(state.plays[0].targetTeamId).toBe(TEAM_B);

    expect(state.challenges).toHaveLength(1);
    expect(state.challenges[0].challengeId).toBe("chal-1");
    expect(state.challenges[0].status).toBe("open");

    expect(state.offers).toHaveLength(1);
    expect(state.offers[0].offerId).toBe("offer-1");
    expect(state.offers[0].challengeId).toBe("chal-1");

    expect(state.effects).toHaveLength(1);
    expect(state.effects[0].effectId).toBe("eff-1");
    expect(state.effects[0].kind).toBe("bar_lock");
    // start_announced_at present -> startAnnounced true; end flag null -> false.
    expect(state.effects[0].startAnnounced).toBe(true);
    expect(state.effects[0].endAnnounced).toBe(false);

    expect(state.awards).toHaveLength(1);
    expect(state.awards[0].awardId).toBe("award-1");
    expect(state.awards[0].kind).toBe("happy_hour_bonus");

    expect(state.ledger).toEqual([
      { teamId: TEAM_A, barId: BAR_1, category: "bar_share", points: 12 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Write helpers — idempotent upserts.
// ---------------------------------------------------------------------------

function challenge(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
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

function offer(
  overrides: Partial<FairestOfferRecord> = {},
): FairestOfferRecord {
  return {
    offerId: "offer-1",
    sourcePlayId: "play-1",
    slug: "fairest-of-them-all",
    holderTeamId: TEAM_B,
    originalCasterTeamId: TEAM_A,
    challengeId: "chal-1",
    restrictionEffectId: null,
    status: "pending",
    decidedAt: null,
    mirroredChallengeId: null,
    mirroredEffectId: null,
    ...overrides,
  };
}

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
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

describe("write helpers: idempotent upserts (R20.1)", () => {
  it("writeChallenges upserts by id and converges on re-run", async () => {
    const db = freshDb();
    await writeChallenges(db.runner, GAME, [challenge()]);
    expect(db.challenges.size).toBe(1);

    // Re-run the same plan with a resolved status: still one row, mutated.
    await writeChallenges(db.runner, GAME, [
      challenge({ status: "completed", resolvedByKind: "team" }),
    ]);
    expect(db.challenges.size).toBe(1);
    expect(db.challenges.get("chal-1")?.status).toBe("completed");
    // The upsert statement carries the on-conflict clause.
    expect(
      db.sqlCalls.some((s) => s.includes("on conflict (id) do update")),
    ).toBe(true);
    // Two writes issued, one row survives => idempotent by id.
    expect(db.countSql("insert into card_challenges")).toBe(2);
  });

  it("writeOffers upserts by id and converges on re-run", async () => {
    const db = freshDb();
    await writeOffers(db.runner, GAME, [offer()]);
    await writeOffers(db.runner, GAME, [
      offer({ status: "played", decidedAt: NOW }),
    ]);
    expect(db.offers.size).toBe(1);
    expect(db.offers.get("offer-1")?.status).toBe("played");
    expect(db.countSql("insert into fairest_offers")).toBe(2);
  });

  it("writeEffects upserts by id, resolving bar keys and stamping the start flag", async () => {
    const db = freshDb();
    const state = await loadBehaviorState(db.runner, GAME, NOW);

    await writeEffects(db.runner, GAME, [effect()], state.bars);
    await writeEffects(
      db.runner,
      GAME,
      [effect({ cancelledAt: NOW, cancelReason: "host" })],
      state.bars,
    );

    expect(db.effects.size).toBe(1);
    const row = db.effects.get("eff-1");
    // targetBarKey resolved to the row's bar id via the state bar map.
    expect(row?.target_bar_id).toBe(BAR_1);
    expect(row?.target_bar_key).toBe(BAR_1);
    // An immediate-start effect is stamped announced at its start.
    expect(row?.start_announced_at).toBe(NOW);
    // Re-run mutated the lifecycle fields in place.
    expect(row?.cancelled_at).toBe(NOW);
    expect(row?.cancel_reason).toBe("host");
    expect(db.countSql("insert into card_effects")).toBe(2);
  });

  it("writeEffects leaves a delayed-start effect unannounced for the Timer_Sweep", async () => {
    const db = freshDb();
    const state = await loadBehaviorState(db.runner, GAME, NOW);
    await writeEffects(
      db.runner,
      GAME,
      [
        effect({
          effectId: "eff-delay",
          slug: "cancel-culture",
          kind: "radius_lock",
          startAnnounced: false,
        }),
      ],
      state.bars,
    );
    // startAnnounced false (Cancel Culture) -> left null for the sweep.
    expect(db.effects.get("eff-delay")?.start_announced_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileBarsInTx — minimal ledger diff with phantom + Insurance floors.
// ---------------------------------------------------------------------------

/**
 * Build a loaded snapshot with the given active claims and prior ledger so the
 * reconcile can diff against existing holdings. Bars resolve by uuid key.
 */
async function stateWith(
  db: FakeDb,
  claims: ClaimRecordRow[],
  ledger: LedgerRow[],
): Promise<BehaviorState> {
  db.claims.push(...claims);
  db.ledger.push(...ledger);
  return loadBehaviorState(db.runner, GAME, NOW);
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

const NO_OVERRIDES: AllocationOverrides = {};

describe("reconcileBarsInTx: minimal ledger diff", () => {
  it("awards a full solo share to a single first claimant", async () => {
    const db = freshDb();
    const state = await stateWith(
      db,
      [activeClaim("claim-a", TEAM_A, BAR_1)],
      [],
    );

    const entries = await reconcileBarsInTx(
      db.runner,
      state,
      [BAR_1],
      NO_OVERRIDES,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      teamId: TEAM_A,
      barId: BAR_1,
      category: "bar_share",
      points: 12,
      sourceClaimId: "claim-a",
    });
  });

  it("corrects an existing claimant down when a second team joins", async () => {
    const db = freshDb();
    // TEAM_A already holds the full 12 from an earlier solo claim.
    const state = await stateWith(
      db,
      [
        activeClaim("claim-a", TEAM_A, BAR_1),
        activeClaim("claim-b", TEAM_B, BAR_1),
      ],
      [
        {
          id: "ledger-prior",
          team_id: TEAM_A,
          bar_id: BAR_1,
          category: "bar_share",
          points: 12,
          source_claim_id: "claim-a",
          source_effect_id: null,
          metadata: {},
        },
      ],
    );

    const entries = await reconcileBarsInTx(
      db.runner,
      state,
      [BAR_1],
      NO_OVERRIDES,
    );

    // Two claimants -> target 6 each. The diff corrects A down by 6 and gives B 6.
    const byTeam = new Map(entries.map((e) => [e.teamId, e]));
    expect(byTeam.get(TEAM_A)).toMatchObject({
      category: "bar_share_correction",
      points: -6,
    });
    expect(byTeam.get(TEAM_B)).toMatchObject({
      category: "bar_share",
      points: 6,
    });
  });

  it("emits no entries when holdings already equal the target", async () => {
    const db = freshDb();
    const state = await stateWith(
      db,
      [activeClaim("claim-a", TEAM_A, BAR_1)],
      [
        {
          id: "ledger-prior",
          team_id: TEAM_A,
          bar_id: BAR_1,
          category: "bar_share",
          points: 12,
          source_claim_id: "claim-a",
          source_effect_id: null,
          metadata: {},
        },
      ],
    );

    const entries = await reconcileBarsInTx(
      db.runner,
      state,
      [BAR_1],
      NO_OVERRIDES,
    );
    expect(entries).toEqual([]);
  });

  it("drops a single claimant's share when a Party Crasher phantom shares", async () => {
    const db = freshDb();
    const state = await stateWith(
      db,
      [activeClaim("claim-a", TEAM_A, BAR_1)],
      [],
    );

    const entries = await reconcileBarsInTx(db.runner, state, [BAR_1], {
      phantom: new Set([BAR_1]),
    });

    // 1 real claimant + 1 phantom => divisor 2 => 6 for the real team.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ teamId: TEAM_A, points: 6 });
  });

  it("honors an Insurance protected floor above the equal split", async () => {
    const db = freshDb();
    const state = await stateWith(
      db,
      [
        activeClaim("claim-a", TEAM_A, BAR_1),
        activeClaim("claim-b", TEAM_B, BAR_1),
      ],
      [],
    );

    const floors = new Map<string, ReadonlyMap<string, number>>([
      [BAR_1, new Map([[TEAM_A, 12]])],
    ]);
    const entries = await reconcileBarsInTx(db.runner, state, [BAR_1], {
      protectedFloors: floors,
    });

    // Equal split is 6 each, but A's Insurance floor keeps it at 12; B gets 6.
    const byTeam = new Map(entries.map((e) => [e.teamId, e.points]));
    expect(byTeam.get(TEAM_A)).toBe(12);
    expect(byTeam.get(TEAM_B)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// endGameEffects — game_ended cancellation (R20.6).
// ---------------------------------------------------------------------------

describe("endGameEffects: game-end cancellation (R20.6)", () => {
  it("cancels every live effect with reason game_ended, sparing settled ones", async () => {
    const db = freshDb();
    // Live effect — should be cancelled.
    db.effects.set("eff-live", {
      id: "eff-live",
      cancelled_at: null,
      consumed_at: null,
    });
    // Already consumed — untouched.
    db.effects.set("eff-consumed", {
      id: "eff-consumed",
      cancelled_at: null,
      consumed_at: "2024-01-01T11:50:00.000Z",
    });
    // Already cancelled — untouched.
    db.effects.set("eff-cancelled", {
      id: "eff-cancelled",
      cancelled_at: "2024-01-01T11:55:00.000Z",
      consumed_at: null,
      cancel_reason: "host",
    });

    await endGameEffects(db.runner, GAME);

    expect(db.effects.get("eff-live")?.cancel_reason).toBe("game_ended");
    expect(db.effects.get("eff-live")?.cancelled_at).not.toBeNull();
    // A consumed effect keeps its null cancel fields.
    expect(db.effects.get("eff-consumed")?.cancel_reason).toBeUndefined();
    // A previously host-cancelled effect keeps its original reason.
    expect(db.effects.get("eff-cancelled")?.cancel_reason).toBe("host");
  });
});
