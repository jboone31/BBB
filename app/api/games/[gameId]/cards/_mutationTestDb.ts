/**
 * Shared hermetic test harness for the Card_Behavior_Mutation routes
 * (discard / keep / forfeit — card-behavior Task 7.4).
 *
 * The reworked routes no longer delegate to a single mockable helper; they run
 * the real pipeline (`loadCardMutationContext`: authorize + lock, server `now`,
 * lazy settle, `loadBehaviorState`; then `loadDeckStateWithOrigin`, the pure
 * deck transition, `settleInventoryChange`, and `persistDeckTransition`). So the
 * tests exercise that whole pipeline against an in-memory fake {@link QueryRunner}
 * that recognizes the specific statements each stage issues (matched by a stable
 * SQL substring) and applies them to in-memory tables — the same `FakeDb` style
 * used by `lib/cards/behaviorStore.test.ts` and `lib/cards/persistence.test.ts`.
 *
 * This file is NOT a test (it does not end in `.test.ts`), so vitest's `include`
 * glob never runs it directly; the three route tests import it.
 *
 * The fake models exactly the pipeline the routes drive, so a test can:
 *   - stage challenges / offers / deck instances that `loadBehaviorState` and
 *     `loadDeckStateWithOrigin` read back;
 *   - observe the appended `game_events` rows (both the lazy-settle transition
 *     events it is told to emit and the route's single mutation event) in order,
 *     so "transition events precede the mutation event", "exactly one mutation
 *     event", and "write nothing" are directly assertable;
 *   - observe the deck-instance upserts (so a UIOLI completion / Fairest void is
 *     visible on the inventory event payload, and a rejection wrote no rows);
 *   - inject a thrown error on the mutation append so a rollback is assertable.
 */

import type { QueryRunner } from "@/lib/events";
import { CARD_SLUGS } from "@/lib/cards/catalog";

/** A persisted `card_instances` row in the fake, in the persistence shape. */
export interface InstanceSeed {
  readonly slug: string;
  readonly deckState: "deck" | "pending" | "hand" | "played" | "discarded";
  readonly drawPosition: number;
  readonly pendingBarId?: string | null;
}

/** A staged `card_challenges` row (only the fields the pipeline reads). */
export interface ChallengeSeed {
  readonly id: string;
  readonly slug: string;
  readonly sourcePlayId: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string | null;
  readonly status: string;
  readonly params?: Record<string, unknown>;
}

/**
 * A staged `card_effects` row (only the fields the pipeline reads back through
 * `loadBehaviorState`'s `EFFECTS_SQL` / `readEffectRow`). Anything omitted takes
 * the neutral default of an active, un-cancelled, un-consumed effect.
 */
export interface EffectSeed {
  readonly id: string;
  readonly slug: string;
  readonly kind: string;
  readonly sourcePlayId?: string | null;
  readonly sourceChallengeId?: string | null;
  readonly ownerTeamId?: string | null;
  readonly targetTeamId?: string | null;
  /** The bar FK this effect targets (resolved to a key via the bar map). */
  readonly targetBarId?: string | null;
  readonly startsAt?: string;
  readonly endsAt?: string | null;
  readonly params?: Record<string, unknown>;
  readonly attachedClaimId?: string | null;
  /** The bar FK this effect's protection is attached to (Insurance). */
  readonly attachedBarId?: string | null;
  readonly protectedPoints?: number | null;
  readonly consumedAt?: string | null;
  readonly cancelledAt?: string | null;
  readonly cancelReason?: string | null;
  readonly startAnnouncedAt?: string | null;
  readonly endAnnouncedAt?: string | null;
}

/** A staged `fairest_offers` row (only the fields the pipeline reads). */
export interface OfferSeed {
  readonly id: string;
  readonly sourcePlayId: string;
  readonly holderTeamId: string;
  readonly originalCasterTeamId: string;
  readonly challengeId: string | null;
  readonly status: string;
  readonly slug?: string;
}

/** An appended `game_events` row the fake recorded, in append order. */
export interface AppendedEvent {
  readonly seq: number;
  readonly eventType: string;
  readonly actorTeamId: string | null;
  readonly payload: Record<string, unknown>;
}

/** An observed `card_instances` upsert (the row the persistence layer wrote). */
export interface InstanceUpsert {
  readonly slug: string;
  readonly deckState: string;
}

/** An observed `card_challenges` upsert (the patched challenge row written). */
export interface ChallengeUpsert {
  readonly id: string;
  readonly status: string;
  readonly failureEffectId: string | null;
}

/** An observed `card_effects` upsert (the effect row written, e.g. a critic block). */
export interface EffectUpsert {
  readonly id: string;
  readonly kind: string;
  readonly targetTeamId: string | null;
}

/** An observed `fairest_offers` upsert (the offer row written by a Fairest decision). */
export interface OfferUpsert {
  readonly id: string;
  readonly slug: string;
  readonly holderTeamId: string;
  readonly status: string;
  readonly mirroredChallengeId: string | null;
  readonly mirroredEffectId: string | null;
}

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_A = "22222222-2222-4222-8222-222222222222";
const TEAM_B = "33333333-3333-4333-8333-333333333333";
const START_BAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINISH_BAR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "host-session-aaaa";

export const IDS = {
  gameId: GAME_ID,
  teamA: TEAM_A,
  teamB: TEAM_B,
  startBar: START_BAR,
  finishBar: FINISH_BAR,
  host: HOST,
} as const;

export interface FakeDbOptions {
  /** Whether the acting session is a member (default true). */
  readonly member?: boolean;
  /**
   * Whether `assertAdmin` reports the acting session as the game's admin
   * (default true). The admin check runs `ADMIN_CHECK_SQL` — distinguished from
   * `loadBehaviorState`'s game read by its `(admin_session_id = $2) as is_admin`
   * projection — so host-override routes drive it. When false the fake returns a
   * game row with `is_admin = false`, modelling a non-host requester.
   */
  readonly admin?: boolean;
  /** The game lifecycle the lifecycle probe reports (default "live"). */
  readonly lifecycle?: "lobby" | "live" | "ended";
  /** Whether the lifecycle probe finds a game row (default true). */
  readonly gameExists?: boolean;
  /** The acting session's team id, or null for a teamless requester. */
  readonly teamId?: string | null;
  /** The acting team's persisted deck instances (persistence shape). */
  readonly instances?: readonly InstanceSeed[];
  /** Staged challenges `loadBehaviorState` returns. */
  readonly challenges?: readonly ChallengeSeed[];
  /** Staged offers `loadBehaviorState` returns. */
  readonly offers?: readonly OfferSeed[];
  /** Staged effects `loadBehaviorState` returns (host effect-end route). */
  readonly effects?: readonly EffectSeed[];
  /** The persisted `team_decks.pending_mode` the deck load reads (default "choose_one"). */
  readonly pendingMode?: "choose_one" | "keep_all";
  /**
   * How many transition events the lazy settle appends before the mutation
   * (modelling `bbb_settle_card_effects`). Each shows up as an `effect_expired`
   * event in {@link FakeMutationDb.events}, ahead of the mutation event.
   */
  readonly dueTransitions?: number;
  /** Throw on the mutation event append, to exercise rollback (default false). */
  readonly failMutationAppend?: boolean;
}

/**
 * An in-memory SQL-shaped store for the discard/keep/forfeit pipeline. It does
 * not interpret arbitrary SQL; it recognizes the specific statements the routes
 * drive (each matched by a stable substring) and applies them to in-memory
 * tables, mirroring the `FakeDb` recognizers in `behaviorStore.test.ts`.
 */
export class FakeMutationDb {
  private readonly member: boolean;
  private readonly admin: boolean;
  private readonly lifecycle: "lobby" | "live" | "ended";
  private readonly gameExists: boolean;
  private readonly actingTeamId: string | null;
  private readonly instances: InstanceSeed[];
  private readonly challenges: ChallengeSeed[];
  private readonly offers: OfferSeed[];
  private readonly effects: EffectSeed[];
  private readonly pendingMode: "choose_one" | "keep_all";
  private readonly dueTransitions: number;
  private readonly failMutationAppend: boolean;

  /** Appended events in order (lazy-settle transitions first, then mutation). */
  readonly events: AppendedEvent[] = [];
  /** Observed `card_instances` upserts (the persisted row diff). */
  readonly instanceUpserts: InstanceUpsert[] = [];
  /** Observed `team_decks` upserts (so a write-free rejection is assertable). */
  readonly teamDeckUpserts: Array<{ pendingMode: string }> = [];
  /** Observed `card_challenges` upserts (patched challenge rows, e.g. a resolve). */
  readonly challengeUpserts: ChallengeUpsert[] = [];
  /** Observed `card_effects` upserts (new effect rows, e.g. a critic block). */
  readonly effectUpserts: EffectUpsert[] = [];
  /** Observed `fairest_offers` upserts (decided + voided offer rows). */
  readonly offerUpserts: OfferUpsert[] = [];
  /**
   * Observed in-place `card_effects` updates from the host effect-end route
   * (`HOST_END_EFFECT_SQL` with `cancel_reason = 'host'` and
   * `RELEASE_PROTECTION_SQL` with `cancel_reason = 'protection_released'`),
   * recorded as `{ id, cancelReason }` so a host end / release is assertable.
   */
  readonly effectUpdates: Array<{ id: string; cancelReason: string }> = [];
  /** Observed `score_ledger_entries` inserts (reconciliation diffs). */
  readonly ledgerInserts: Array<{
    teamId: string;
    barId: string | null;
    category: string;
    points: number;
  }> = [];
  /** Every SQL statement seen, for substring-count assertions. */
  readonly sqlCalls: string[] = [];

  private seq = 100;

  constructor(options: FakeDbOptions = {}) {
    this.member = options.member ?? true;
    this.admin = options.admin ?? true;
    this.lifecycle = options.lifecycle ?? "live";
    this.gameExists = options.gameExists ?? true;
    this.actingTeamId = options.teamId === undefined ? TEAM_A : options.teamId;
    this.instances = [...(options.instances ?? [])];
    this.challenges = [...(options.challenges ?? [])];
    this.offers = [...(options.offers ?? [])];
    this.effects = [...(options.effects ?? [])];
    this.pendingMode = options.pendingMode ?? "choose_one";
    this.dueTransitions = options.dueTransitions ?? 0;
    this.failMutationAppend = options.failMutationAppend ?? false;
  }

  /** The last error thrown by {@link dispatch} that was NOT the injected one. */
  lastUnhandled: unknown = null;

  readonly runner: QueryRunner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      this.sqlCalls.push(sql);
      try {
        return { rows: this.dispatch(sql, params) };
      } catch (err) {
        if (!(
          err instanceof Error && err.message === "injected append failure"
        )) {
          this.lastUnhandled = err;
        }
        throw err;
      }
    },
  };

  /** The single mutation event (the non-transition append), if any. */
  get mutationEvents(): AppendedEvent[] {
    return this.events.filter((e) => e.eventType !== "effect_expired");
  }

  /** The lazy-settle transition events, in append order. */
  get transitionEvents(): AppendedEvent[] {
    return this.events.filter((e) => e.eventType === "effect_expired");
  }

  countSql(substring: string): number {
    return this.sqlCalls.filter((s) => s.includes(substring)).length;
  }

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    // --- Pipeline step 1: authorize (MEMBERSHIP_SQL). -----------------------
    // `with locked as (... for update) select 1 from locked g ...`
    if (sql.includes("from locked g")) {
      return this.member ? [{ "?column?": 1 }] : [];
    }

    // --- Pipeline step 1: admin authorize (ADMIN_CHECK_SQL in _shared). -----
    // `select id, lifecycle, admin_session_id, ..., (admin_session_id = $2) as
    // is_admin from games where id = $1 for update`. Distinguished from
    // `loadBehaviorState`'s game read by its `is_admin` projection, so it must be
    // matched BEFORE the behaviorStore game recognizer below. A missing game
    // returns no row (assertAdmin → not_found); a present game reports is_admin
    // from the `admin` option so host routes can drive both branches.
    if (sql.includes("is_admin") && sql.includes("from games")) {
      if (!this.gameExists) return [];
      return [
        {
          id: GAME_ID,
          lifecycle: this.lifecycle,
          admin_session_id: HOST,
          start_bar_id: START_BAR,
          finish_bar_id: FINISH_BAR,
          is_admin: this.admin,
        },
      ];
    }

    // --- Pipeline step 1: lifecycle probe (GAME_LIFECYCLE_SQL in _shared). --
    // `select lifecycle from games where id = $1` (no admin/bar columns).
    if (
      sql.includes("select lifecycle") &&
      sql.includes("from games") &&
      !sql.includes("admin_session_id")
    ) {
      return this.gameExists ? [{ lifecycle: this.lifecycle }] : [];
    }

    // --- Pipeline step 1: acting team (PLAYER_FOR_SESSION_SQL). -------------
    // `select team_id from players where game_id = $1 and session_id = $2`.
    if (sql.includes("select team_id") && sql.includes("from players")) {
      return this.actingTeamId == null
        ? [{ team_id: null }]
        : [{ team_id: this.actingTeamId }];
    }

    // --- Pipeline step 2: server clock. -------------------------------------
    if (sql.includes("clock_timestamp()")) {
      return [{ now: "2024-01-01T12:00:00.000Z" }];
    }

    // --- Pipeline step 3: lazy settle. --------------------------------------
    // Appends `dueTransitions` transition events BEFORE the mutation, exactly
    // as the real settle function does, so their seqs precede the mutation's.
    if (sql.includes("bbb_settle_card_effects")) {
      for (let i = 0; i < this.dueTransitions; i += 1) {
        this.seq += 1;
        this.events.push({
          seq: this.seq,
          eventType: "effect_expired",
          actorTeamId: null,
          payload: { settled: true },
        });
      }
      return [{ appended: this.dueTransitions }];
    }
    if (sql.includes("max(seq) as last_seq")) {
      return [{ last_seq: this.events.length === 0 ? null : this.seq }];
    }

    // --- resolveGameBar: designations-only games probe. ---------------------
    // `select start_bar_id, finish_bar_id from games where id = $1` (no
    // lifecycle / admin columns), issued by the bar resolver during the load.
    if (
      sql.includes("from games") &&
      sql.includes("start_bar_id") &&
      !sql.includes("admin_session_id") &&
      !sql.includes("lifecycle")
    ) {
      return [{ start_bar_id: START_BAR, finish_bar_id: FINISH_BAR }];
    }
    // --- loadBehaviorState: game row (GAME_SQL with designations). ----------
    if (
      sql.includes("from games") &&
      sql.includes("admin_session_id") &&
      sql.includes("lifecycle")
    ) {
      return [
        {
          lifecycle: this.lifecycle,
          admin_session_id: HOST,
          start_bar_id: START_BAR,
          finish_bar_id: FINISH_BAR,
        },
      ];
    }
    // --- loadBehaviorState: teams. ------------------------------------------
    if (sql.includes("from teams t")) {
      return [
        { team_id: TEAM_A, name: "Alpha", member_session_ids: ["session-a"] },
        { team_id: TEAM_B, name: "Bravo", member_session_ids: ["session-b"] },
      ];
    }
    // --- loadBehaviorState / resolver: bars. --------------------------------
    if (sql.includes("from bars")) {
      return [
        { id: START_BAR, name: "Start Place", location: null },
        { id: FINISH_BAR, name: "Finish Place", location: null },
      ];
    }
    // --- loadBehaviorState: claims. -----------------------------------------
    if (sql.includes("from claims c")) {
      return [];
    }
    // --- loadBehaviorState: card instances (owner_team_id shape). -----------
    if (
      sql.includes("from card_instances ci") &&
      sql.includes("ci.owner_team_id") &&
      !sql.includes("ci.pending_bar_id")
    ) {
      return this.instances.map((i) => ({
        owner_team_id: this.actingTeamId,
        slug: i.slug,
        deck_state: i.deckState,
        draw_position: i.drawPosition,
      }));
    }
    // --- loadBehaviorState: plays. ------------------------------------------
    if (sql.includes("from card_plays")) {
      return [];
    }
    // --- loadBehaviorState: challenges. -------------------------------------
    if (sql.includes("from card_challenges")) {
      return this.challenges.map((c) => ({
        id: c.id,
        slug: c.slug,
        source_play_id: c.sourcePlayId,
        caster_team_id: c.casterTeamId,
        target_team_id: c.targetTeamId,
        params: c.params ?? { kind: "none" },
        mirrored_from_challenge_id: null,
        mirrored_from_play_id: null,
        status: c.status,
        created_at: "2024-01-01T11:00:00.000Z",
        resolved_at: null,
        resolved_by_kind: null,
        resolved_by_team_id: null,
        resolved_by_session_id: null,
        failure_effect_id: null,
      }));
    }
    // --- loadBehaviorState: offers. -----------------------------------------
    if (sql.includes("from fairest_offers")) {
      return this.offers.map((o) => ({
        id: o.id,
        source_play_id: o.sourcePlayId,
        slug: o.slug ?? "fairest-of-them-all",
        holder_team_id: o.holderTeamId,
        original_caster_team_id: o.originalCasterTeamId,
        challenge_id: o.challengeId,
        restriction_effect_id: null,
        status: o.status,
        decided_at: null,
        mirrored_challenge_id: null,
        mirrored_effect_id: null,
      }));
    }
    // --- loadBehaviorState: effects. ----------------------------------------
    // Rows in the `EFFECTS_SQL` / `readEffectRow` shape. `target_bar_id` /
    // `attached_bar_id` are the bar FKs the loader resolves to a board key via
    // the bar map (so seed them with START_BAR / FINISH_BAR, which the bar
    // recognizer returns). Unset lifecycle fields default to an active effect.
    if (sql.includes("from card_effects e")) {
      return this.effects.map((e) => ({
        id: e.id,
        slug: e.slug,
        kind: e.kind,
        source_play_id: e.sourcePlayId ?? "play-1",
        source_challenge_id: e.sourceChallengeId ?? null,
        owner_team_id: e.ownerTeamId ?? null,
        target_team_id: e.targetTeamId ?? null,
        target_bar_id: e.targetBarId ?? null,
        target_bar_key: null,
        starts_at: e.startsAt ?? "2024-01-01T11:00:00.000Z",
        ends_at: e.endsAt ?? null,
        params: e.params ?? {},
        attached_claim_id: e.attachedClaimId ?? null,
        attached_bar_id: e.attachedBarId ?? null,
        attached_bar_name: null,
        protected_points: e.protectedPoints ?? null,
        consumed_at: e.consumedAt ?? null,
        cancelled_at: e.cancelledAt ?? null,
        cancel_reason: e.cancelReason ?? null,
        start_announced_at: e.startAnnouncedAt ?? e.startsAt ?? null,
        end_announced_at: e.endAnnouncedAt ?? null,
      }));
    }
    // --- loadBehaviorState: awards. -----------------------------------------
    if (sql.includes("from card_effect_awards")) {
      return [];
    }
    // --- loadBehaviorState: ledger. -----------------------------------------
    if (sql.includes("from score_ledger_entries")) {
      return [];
    }

    // --- loadDeckStateWithOrigin: persistence instance load. ----------------
    // Distinguished from the behaviorStore load by `ci.pending_bar_id`.
    if (
      sql.includes("from card_instances ci") &&
      sql.includes("ci.pending_bar_id")
    ) {
      return this.instances.map((i, idx) => ({
        id: `inst-${idx}`,
        definition_id: `def-${i.slug}`,
        slug: i.slug,
        deck_state: i.deckState,
        state: i.deckState === "played" ? "played" : "in_hand",
        draw_position: i.drawPosition,
        pending_bar_id: i.pendingBarId ?? null,
      }));
    }
    // --- loadDeckStateWithOrigin: drawn bars. -------------------------------
    if (sql.includes("from card_draws")) {
      return [];
    }
    // --- loadDeckStateWithOrigin: team_decks select. ------------------------
    if (sql.includes("from team_decks")) {
      return [{ next_draw_position: 0, pending_mode: this.pendingMode }];
    }
    // --- loadDeckSeed (only hit on a freshly seeded deck). ------------------
    if (sql.includes("deck_seed")) {
      return [{ deck_seed: "seed" }];
    }

    // --- persistDeckRows: card definitions. ---------------------------------
    if (sql.includes("from card_definitions")) {
      return ALL_SLUGS.map((slug) => ({ id: `def-${slug}`, slug }));
    }
    // --- persistDeckRows: instance upsert. ----------------------------------
    if (sql.includes("insert into card_instances")) {
      // params: id, gameId, definitionId, teamId, position, deckState, ...
      const deckState = String(params[5]);
      const definitionId = String(params[2]);
      const slug = definitionId.startsWith("def-")
        ? definitionId.slice("def-".length)
        : definitionId;
      this.instanceUpserts.push({ slug, deckState });
      return [];
    }
    // --- persistDeckRows: team_decks upsert. --------------------------------
    if (sql.includes("insert into team_decks")) {
      this.teamDeckUpserts.push({ pendingMode: String(params[4]) });
      return [];
    }

    // --- writeChallenges: challenge upsert (challenge-resolution route). ----
    // params: id, gameId, sourcePlayId, slug, caster, target, params,
    //   mirroredFromChallenge, mirroredFromPlay, status(9), createdAt,
    //   resolvedAt, resolvedByKind, resolvedByTeam, resolvedBySession,
    //   failureEffectId(15).
    if (sql.includes("insert into card_challenges")) {
      this.challengeUpserts.push({
        id: String(params[0]),
        status: String(params[9]),
        failureEffectId: params[15] == null ? null : String(params[15]),
      });
      return [];
    }
    // --- writeEffects: effect upsert (e.g. the critic team_claim_block). -----
    // params: id, gameId, sourcePlayId, sourceChallengeId, slug, kind(5),
    //   ownerTeam, targetTeam(7), ...
    if (sql.includes("insert into card_effects")) {
      this.effectUpserts.push({
        id: String(params[0]),
        kind: String(params[5]),
        targetTeamId: params[7] == null ? null : String(params[7]),
      });
      return [];
    }

    // --- writeOffers: fairest_offers upsert (Fairest decision route). -------
    // params: id, gameId, sourcePlayId, slug(3), holderTeamId(4), caster,
    //   challengeId, restrictionEffectId, status(8), createdAt, decidedAt,
    //   mirroredChallengeId(11), mirroredEffectId(12).
    if (sql.includes("insert into fairest_offers")) {
      this.offerUpserts.push({
        id: String(params[0]),
        slug: String(params[3]),
        holderTeamId: String(params[4]),
        status: String(params[8]),
        mirroredChallengeId: params[11] == null ? null : String(params[11]),
        mirroredEffectId: params[12] == null ? null : String(params[12]),
      });
      return [];
    }

    // --- host effect-end: cancel the effect in place (HOST_END_EFFECT_SQL). -
    // `update card_effects set cancelled_at = now(), cancel_reason = 'host' ...`
    // params: $1 gameId, $2 effectId.
    if (
      sql.includes("update card_effects") &&
      sql.includes("cancel_reason = 'host'")
    ) {
      this.effectUpdates.push({ id: String(params[1]), cancelReason: "host" });
      return [];
    }
    // --- host effect-end: release an attached Insurance (RELEASE_PROTECTION). -
    // `update card_effects set ... cancel_reason = 'protection_released' ...`.
    if (
      sql.includes("update card_effects") &&
      sql.includes("cancel_reason = 'protection_released'")
    ) {
      this.effectUpdates.push({
        id: String(params[1]),
        cancelReason: "protection_released",
      });
      return [];
    }

    // --- reconcileBarsInTx: append a ledger diff (INSERT_LEDGER_SQL). --------
    // params: gameId, teamId, barId, sourceClaimId, sourceEffectId, category,
    //   points, metadata; `returning id`.
    if (sql.includes("insert into score_ledger_entries")) {
      this.seq += 1;
      this.ledgerInserts.push({
        teamId: String(params[1]),
        barId: params[2] == null ? null : String(params[2]),
        category: String(params[5]),
        points: Number(params[6]),
      });
      return [{ id: `ledger-${this.seq}` }];
    }

    // --- appendEvent: the route's single mutation event. --------------------
    if (sql.includes("insert into game_events")) {
      if (this.failMutationAppend) {
        throw new Error("injected append failure");
      }
      this.seq += 1;
      const eventType = String(params[1]);
      const actorTeamId = params[3] == null ? null : String(params[3]);
      const payload =
        typeof params[4] === "string"
          ? (JSON.parse(params[4]) as Record<string, unknown>)
          : (params[4] as Record<string, unknown>);
      this.events.push({
        seq: this.seq,
        eventType,
        actorTeamId,
        payload,
      });
      return [
        {
          id: `e-${this.seq}`,
          game_id: GAME_ID,
          seq: this.seq,
          event_type: eventType,
          actor_kind: params[2],
          actor_team_id: actorTeamId,
          payload: params[4],
          created_at: "2024-01-01T12:00:00.000Z",
        },
      ];
    }

    throw new Error(`FakeMutationDb: unhandled SQL: ${sql.slice(0, 70)}`);
  }
}

/**
 * The full card catalog slugs, so `persistDeckRows`'s `loadDefinitionIds` can
 * resolve a definition id for every seeded card (`def-${slug}`), matching the
 * ids the persistence instance load reports.
 */
const ALL_SLUGS: readonly string[] = CARD_SLUGS;
