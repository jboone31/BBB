/**
 * Hermetic in-memory harness for the claims route tests (card-behavior Task 7.7).
 *
 * The reworked claims route runs the full Card_Behavior_Mutation pipeline —
 * authorize + lock, `clock_timestamp()`, lazy settle, `loadBehaviorState`,
 * `resolveGameBar`, then the claim / unclaim / bonus planners and their writes.
 * This fake {@link QueryRunner} recognizes each statement that pipeline issues
 * (matched by a stable SQL substring) and applies it to in-memory tables, so the
 * tests exercise the real route, planners, block evaluator, reconciliation, and
 * event append against seeded fixtures.
 *
 * Transactions are modelled explicitly: every domain write and every appended
 * event is staged as *pending* and only becomes *committed* when the test's
 * `withTransaction` mock calls {@link FakeClaimsDb.commit}. A thrown error calls
 * {@link FakeClaimsDb.rollback}, discarding the staged writes AND the staged
 * lazy-settle transition events together — so "commits nothing on rollback" and
 * "a rejection commits only transition events" are directly assertable.
 *
 * Not a test file (no `.test.ts` suffix); imported by `route.test.ts`.
 */

import type { QueryRunner } from "@/lib/events";

export const GAME_ID = "game-1";
export const TEAM_A = "team-a";
export const TEAM_B = "team-b";
export const NOW_ISO = "2024-01-01T12:00:00.000Z";

/** Seeded bars. Names are not catalog candidates, so each bar's key is its id. */
export const BARS = {
  start: { id: "bar-start", name: "Start Place", location: "33.7600,-84.3600" },
  finish: {
    id: "bar-finish",
    name: "Finish Place",
    location: "33.8000,-84.3600",
  },
  a: { id: "bar-a", name: "Alpha Tavern", location: "33.7700,-84.3600" },
  /** ~0.07 mi north of bar A: a Cancel Culture center that covers bar A. */
  c: { id: "bar-c", name: "Center Pub", location: "33.7710,-84.3600" },
} as const;

export interface ClaimSeed {
  readonly id: string;
  readonly teamId: string;
  readonly barId: string;
  readonly claimedAt?: string;
  readonly revokedAt?: string | null;
}

export interface ChallengeSeed {
  readonly id: string;
  readonly slug: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string;
  readonly status: string;
}

export interface EffectSeed {
  readonly id: string;
  readonly slug: string;
  readonly kind: string;
  readonly ownerTeamId?: string | null;
  readonly targetTeamId?: string | null;
  /** The board bar key the effect targets (here equal to the bar id). */
  readonly targetBarKey?: string | null;
  readonly startsAt?: string;
  readonly endsAt?: string | null;
  readonly params?: Record<string, unknown>;
  readonly attachedClaimId?: string | null;
  readonly protectedPoints?: number | null;
  readonly consumedAt?: string | null;
  readonly cancelledAt?: string | null;
  /** Announcement flags; default null (no transition event appended yet). */
  readonly startAnnouncedAt?: string | null;
  readonly endAnnouncedAt?: string | null;
}

export interface AwardSeed {
  readonly id: string;
  readonly effectId: string;
  readonly teamId: string;
  readonly kind: "happy_hour_bonus" | "patient_investor_award";
  readonly claimId: string | null;
  readonly ledgerEntryId: string;
  readonly reversedAt?: string | null;
}

export interface LedgerSeed {
  readonly id: string;
  readonly teamId: string;
  readonly barId: string;
  readonly category: string;
  readonly points: number;
}

export interface FakeClaimsDbOptions {
  readonly member?: boolean;
  readonly lifecycle?: "lobby" | "live" | "ended";
  readonly teamId?: string | null;
  readonly memberCount?: number;
  readonly nowIso?: string;
  readonly claims?: readonly ClaimSeed[];
  readonly challenges?: readonly ChallengeSeed[];
  readonly effects?: readonly EffectSeed[];
  readonly awards?: readonly AwardSeed[];
  readonly ledger?: readonly LedgerSeed[];
  /** Transition events the lazy settle appends (modelling the SQL settle). */
  readonly dueTransitions?: number;
  /** Throw when appending an event of this type (rollback injection). */
  readonly failAppendOfType?: string;
}

/** A staged / committed domain write, tagged by table and operation. */
export interface DomainWrite {
  readonly table: string;
  readonly op: string;
  readonly detail: Record<string, unknown>;
}

export interface FakeEvent {
  readonly seq: number;
  readonly eventType: string;
  readonly actorTeamId: string | null;
  readonly payload: Record<string, unknown>;
}

const TRANSITION_TYPES = new Set(["effect_activated", "effect_expired"]);

export class FakeClaimsDb {
  private readonly opts: FakeClaimsDbOptions;
  private readonly claims: ClaimSeed[];
  private seq = 100;
  private idCounter = 0;

  /** Every SQL statement seen, in order (for pipeline-ordering assertions). */
  readonly sqlCalls: Array<{ sql: string; params: readonly unknown[] }> = [];

  private pendingWrites: DomainWrite[] = [];
  private pendingEvents: FakeEvent[] = [];
  readonly committedWrites: DomainWrite[] = [];
  readonly committedEvents: FakeEvent[] = [];
  transactions = 0;
  committed = false;
  rolledBack = false;

  constructor(opts: FakeClaimsDbOptions = {}) {
    this.opts = opts;
    this.claims = [...(opts.claims ?? [])];
  }

  begin(): void {
    this.transactions += 1;
    this.pendingWrites = [];
    this.pendingEvents = [];
  }

  commit(): void {
    this.committedWrites.push(...this.pendingWrites);
    this.committedEvents.push(...this.pendingEvents);
    this.pendingWrites = [];
    this.pendingEvents = [];
    this.committed = true;
  }

  rollback(): void {
    this.pendingWrites = [];
    this.pendingEvents = [];
    this.rolledBack = true;
  }

  /** Committed events excluding lazy-settle transition events. */
  get mutationEvents(): FakeEvent[] {
    return this.committedEvents.filter(
      (e) => !TRANSITION_TYPES.has(e.eventType),
    );
  }

  get transitionEvents(): FakeEvent[] {
    return this.committedEvents.filter((e) =>
      TRANSITION_TYPES.has(e.eventType),
    );
  }

  writesTo(table: string): DomainWrite[] {
    return this.committedWrites.filter((w) => w.table === table);
  }

  /** Index of the first SQL statement containing `substring`, or -1. */
  indexOfSql(substring: string): number {
    return this.sqlCalls.findIndex((c) => c.sql.includes(substring));
  }

  readonly runner: QueryRunner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      this.sqlCalls.push({ sql, params });
      return { rows: this.dispatch(sql, params) };
    },
  };

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  private write(table: string, op: string, detail: Record<string, unknown>) {
    this.pendingWrites.push({ table, op, detail });
  }

  private allBars() {
    return [BARS.start, BARS.finish, BARS.a, BARS.c, ...this.materialized];
  }

  private readonly materialized: Array<{
    id: string;
    name: string;
    location: string;
  }> = [];

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    const o = this.opts;

    // --- appendEvent (must precede the `from games` recognizers). ---------
    if (sql.includes("insert into game_events")) {
      const eventType = String(params[1]);
      if (o.failAppendOfType === eventType) {
        throw new Error("injected append failure");
      }
      this.seq += 1;
      const payload = JSON.parse(String(params[4])) as Record<string, unknown>;
      const actorTeamId = params[3] == null ? null : String(params[3]);
      this.pendingEvents.push({
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
          payload,
          created_at: NOW_ISO,
        },
      ];
    }

    // --- Pipeline step 1: authorize + lock. --------------------------------
    if (sql.includes("from locked g")) {
      return (o.member ?? true) ? [{ "?column?": 1 }] : [];
    }

    // --- Pipeline step 2: server clock. -----------------------------------
    if (sql.includes("clock_timestamp()")) {
      return [{ now: o.nowIso ?? NOW_ISO }];
    }

    // --- Pipeline step 3: lazy settle (stages transition events). ---------
    if (sql.includes("bbb_settle_card_effects")) {
      const due = o.dueTransitions ?? 0;
      for (let i = 0; i < due; i += 1) {
        this.seq += 1;
        this.pendingEvents.push({
          seq: this.seq,
          eventType: "effect_expired",
          actorTeamId: null,
          payload: { settled: i },
        });
      }
      return [{ appended: due }];
    }
    if (sql.includes("max(seq) as last_seq")) {
      return [{ last_seq: (o.dueTransitions ?? 0) > 0 ? this.seq : null }];
    }

    // --- Inserts / updates. ------------------------------------------------
    if (sql.includes("insert into bars")) {
      const row = {
        id: this.nextId("bar-new"),
        name: String(params[1]),
        location: String(params[2]),
      };
      this.materialized.push(row);
      this.write("bars", "insert", row);
      return [row];
    }
    if (sql.includes("insert into claims")) {
      const id = this.nextId("claim-new");
      const row: ClaimSeed = {
        id,
        teamId: String(params[1]),
        barId: String(params[2]),
        claimedAt: o.nowIso ?? NOW_ISO,
      };
      this.claims.push(row);
      this.write("claims", "insert", {
        id,
        teamId: row.teamId,
        barId: row.barId,
      });
      return [{ id }];
    }
    if (sql.includes("update claims")) {
      const id = String(params[0]);
      const claim = this.claims.find((c) => c.id === id && !c.revokedAt);
      if (!claim) return [];
      this.write("claims", "revoke", { id });
      return [{ id }];
    }
    if (sql.includes("insert into score_ledger_entries")) {
      const id = this.nextId("ledger");
      this.write("score_ledger_entries", "insert", {
        id,
        teamId: String(params[1]),
        barId: params[2] == null ? null : String(params[2]),
        sourceClaimId: params[3] == null ? null : String(params[3]),
        sourceEffectId: params[4] == null ? null : String(params[4]),
        category: String(params[5]),
        points: Number(params[6]),
      });
      return [{ id }];
    }
    if (sql.includes("insert into card_effect_awards")) {
      const id = this.nextId("award");
      this.write("card_effect_awards", "insert", {
        id,
        effectId: String(params[1]),
        teamId: String(params[2]),
        kind: String(params[3]),
        claimId: params[4] == null ? null : String(params[4]),
        ledgerEntryId: String(params[5]),
      });
      return [{ id }];
    }
    if (sql.includes("update card_effect_awards")) {
      this.write("card_effect_awards", "reverse", {
        id: String(params[1]),
        reversalLedgerEntryId: String(params[2]),
      });
      return [];
    }
    if (sql.includes("update card_effects")) {
      if (sql.includes("'game_ended'")) {
        this.write("card_effects", "end_game", {});
      } else if (sql.includes("'protection_released'")) {
        this.write("card_effects", "release", { id: String(params[1]) });
      } else if (sql.includes("set params")) {
        this.write("card_effects", "counter", {
          id: String(params[1]),
          params: JSON.parse(String(params[2])) as unknown,
          payout: params[3],
        });
      } else if (sql.includes("set attached_claim_id")) {
        this.write("card_effects", "attach", {
          id: String(params[1]),
          claimId: String(params[2]),
          protectedPoints: params[3],
        });
      } else if (sql.includes("consumed_by_claim_id = $3")) {
        this.write("card_effects", "consume", {
          ids: params[1],
          claimId: String(params[2]),
        });
      } else {
        throw new Error(`FakeClaimsDb: unknown card_effects update: ${sql}`);
      }
      return [];
    }
    if (sql.includes("update games")) {
      this.write("games", "end", { reason: "finish_bar_claimed" });
      return [{ id: GAME_ID }];
    }
    // Written by the mocked deck persistence helper (draw-on-claim).
    if (sql.includes("insert into card_draws")) {
      this.write("card_draws", "insert", {
        teamId: String(params[1]),
        barId: String(params[2]),
      });
      return [];
    }

    // --- loadBehaviorState reads (joined statements before plain ones). ---
    if (sql.includes("from claims c")) {
      return this.claims.map((c) => ({
        claim_id: c.id,
        team_id: c.teamId,
        bar_id: c.barId,
        bar_name: "bar",
        claimed_at: c.claimedAt ?? "2024-01-01T11:00:00.000Z",
        revoked_at: c.revokedAt ?? null,
        revoked_reason: c.revokedAt ? "ordinary_unclaim" : null,
      }));
    }
    if (sql.includes("from card_effects e")) {
      return (o.effects ?? []).map((e) => ({
        id: e.id,
        slug: e.slug,
        kind: e.kind,
        source_play_id: "play-1",
        source_challenge_id: null,
        owner_team_id: e.ownerTeamId ?? null,
        target_team_id: e.targetTeamId ?? null,
        target_bar_id: e.targetBarKey ?? null,
        target_bar_key: e.targetBarKey ?? null,
        starts_at: e.startsAt ?? "2024-01-01T11:30:00.000Z",
        ends_at: e.endsAt ?? null,
        params: e.params ?? {},
        attached_claim_id: e.attachedClaimId ?? null,
        attached_bar_id: null,
        attached_bar_name: null,
        protected_points: e.protectedPoints ?? null,
        consumed_at: e.consumedAt ?? null,
        cancelled_at: e.cancelledAt ?? null,
        cancel_reason: null,
        start_announced_at: e.startAnnouncedAt ?? null,
        end_announced_at: e.endAnnouncedAt ?? null,
      }));
    }
    if (sql.includes("from teams t")) {
      return [
        { team_id: TEAM_A, name: "Alpha", member_session_ids: ["session-a"] },
        { team_id: TEAM_B, name: "Bravo", member_session_ids: ["session-b"] },
      ];
    }
    if (sql.includes("member_count")) {
      return [{ member_count: o.memberCount ?? 2 }];
    }
    if (sql.includes("select team_id") && sql.includes("from players")) {
      const teamId = o.teamId === undefined ? TEAM_A : o.teamId;
      return [{ team_id: teamId }];
    }
    if (sql.includes("from games") && sql.includes("lifecycle")) {
      return [
        {
          lifecycle: o.lifecycle ?? "live",
          admin_session_id: "host-session",
          start_bar_id: BARS.start.id,
          finish_bar_id: BARS.finish.id,
        },
      ];
    }
    if (sql.includes("from games") && sql.includes("start_bar_id")) {
      return [{ start_bar_id: BARS.start.id, finish_bar_id: BARS.finish.id }];
    }
    if (sql.includes("from bars")) {
      return this.allBars().map((b) => ({ ...b }));
    }
    if (sql.includes("from claims") && sql.includes("for update")) {
      const barId = String(params[1]);
      return this.claims
        .filter((c) => c.barId === barId && !c.revokedAt)
        .map((c) => ({ id: c.id, team_id: c.teamId }));
    }
    if (sql.includes("from card_instances")) return [];
    if (sql.includes("from card_plays")) return [];
    if (sql.includes("from card_challenges")) {
      return (o.challenges ?? []).map((c) => ({
        id: c.id,
        slug: c.slug,
        source_play_id: "play-1",
        caster_team_id: c.casterTeamId,
        target_team_id: c.targetTeamId,
        params: { kind: "none" },
        mirrored_from_challenge_id: null,
        mirrored_from_play_id: null,
        status: c.status,
        created_at: "2024-01-01T11:00:00.000Z",
        resolved_at: null,
        resolved_by_team_id: null,
        resolved_by_session_id: null,
        resolved_by_kind: null,
        failure_effect_id: null,
      }));
    }
    if (sql.includes("from fairest_offers")) return [];
    if (sql.includes("from card_effect_awards")) {
      return (o.awards ?? []).map((a) => ({
        id: a.id,
        effect_id: a.effectId,
        team_id: a.teamId,
        kind: a.kind,
        claim_id: a.claimId,
        ledger_entry_id: a.ledgerEntryId,
        reversed_at: a.reversedAt ?? null,
        reversal_ledger_entry_id: null,
        created_at: "2024-01-01T11:00:00.000Z",
      }));
    }
    if (sql.includes("from score_ledger_entries")) {
      return (o.ledger ?? []).map((l) => ({
        id: l.id,
        team_id: l.teamId,
        bar_id: l.barId,
        category: l.category,
        points: l.points,
        source_claim_id: null,
        source_effect_id: null,
      }));
    }

    throw new Error(`FakeClaimsDb: unhandled SQL: ${sql.slice(0, 80)}`);
  }
}
