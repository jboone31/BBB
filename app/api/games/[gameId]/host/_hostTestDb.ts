/**
 * Hermetic test harness for the host-override routes (card-behavior Task 11.3).
 *
 * Wraps the shared {@link FakeMutationDb} (`cards/_mutationTestDb.ts`) with the
 * extra state the host routes need, without changing the shared harness:
 *
 *   - a coordinate-bearing scoring bar (`IDS_HOST.midBar`) between the start and
 *     finish bars, so Party Crasher / Insurance reconciliation and Scenic Route
 *     distance checks have real inputs;
 *   - staged claims, ledger rows, and `card_effect_awards` rows that
 *     `loadBehaviorState` reads back (so "awards unchanged" is assertable);
 *   - each challenge's `failure_effect_id` (for a failed Everyone's a Critic);
 *   - `target_bar_key` resolved from the seeded bar FK (bar keys are the uuid for
 *     non-candidate bar names);
 *   - read-your-writes for effect cancellation: a host `update card_effects` or a
 *     `writeEffects` upsert carrying `cancelled_at` is reflected in later effect
 *     reads, so a post-request `loadBehaviorState` sees the cancelled effect and
 *     the claim-block evaluator can be asked whether the team's next claim is
 *     still blocked.
 *
 * Not a test file (no `.test.ts` suffix), so vitest never runs it directly.
 */

import type { QueryRunner } from "@/lib/events";
import type { BehaviorState, ResolvedBarRef } from "@/lib/cards/behaviorState";
import {
  evaluateClaimBlocks,
  previousBarFor,
  type ClaimBlock,
} from "@/lib/claims/blocks";
import type { LatLng } from "@/lib/map/geo";

import {
  FakeMutationDb,
  IDS,
  type FakeDbOptions,
} from "../cards/_mutationTestDb";

/** The fake's server clock (`clock_timestamp()`), mirrored here for fixtures. */
export const NOW = "2024-01-01T12:00:00.000Z";

export const IDS_HOST = {
  ...IDS,
  midBar: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

/** Bar rows with coordinates: start (south) → mid → finish (north). */
const BAR_ROWS = [
  { id: IDS.startBar, name: "Start Place", location: "33.7500,-84.3600" },
  { id: IDS_HOST.midBar, name: "Mid Place", location: "33.7600,-84.3600" },
  { id: IDS.finishBar, name: "Finish Place", location: "33.8000,-84.3600" },
];

export interface ClaimSeed {
  readonly id: string;
  readonly teamId: string;
  readonly barId: string;
  readonly claimedAt?: string;
}

export interface LedgerSeed {
  readonly id: string;
  readonly teamId: string;
  readonly barId: string | null;
  readonly category: string;
  readonly points: number;
  readonly sourceClaimId?: string | null;
  readonly sourceEffectId?: string | null;
}

export interface AwardSeed {
  readonly id: string;
  readonly effectId: string;
  readonly teamId: string;
  readonly kind: "happy_hour_bonus" | "patient_investor_award";
  readonly claimId: string | null;
  readonly ledgerEntryId: string;
}

export interface HostDbOptions extends FakeDbOptions {
  readonly claims?: readonly ClaimSeed[];
  readonly ledger?: readonly LedgerSeed[];
  readonly awards?: readonly AwardSeed[];
  /** challengeId → failure effect id (a failed Everyone's a Critic). */
  readonly failureEffectIds?: Readonly<Record<string, string>>;
}

export class HostTestDb {
  readonly db: FakeMutationDb;
  /** Every SQL statement that touched `card_effect_awards` other than the load. */
  readonly awardWrites: string[] = [];
  private readonly options: HostDbOptions;
  /** effectId → { cancelledAt, cancelReason } written during the request. */
  private readonly cancelled = new Map<
    string,
    { cancelledAt: string; cancelReason: string }
  >();

  constructor(options: HostDbOptions = {}) {
    this.options = options;
    this.db = new FakeMutationDb(options);
  }

  readonly runner: QueryRunner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const local = this.intercept(sql);
      if (local !== undefined) {
        this.db.sqlCalls.push(sql);
        return { rows: local };
      }
      const result = await this.db.runner.query(sql, params);
      return { rows: this.patch(sql, params, result.rows) };
    },
  };

  /** Statements answered here rather than by the shared fake. */
  private intercept(sql: string): Record<string, unknown>[] | undefined {
    if (
      sql.includes("card_effect_awards") &&
      !sql.includes("from card_effect_awards")
    ) {
      this.awardWrites.push(sql);
      return [];
    }
    if (sql.includes("from bars") && !sql.includes("insert into")) {
      return BAR_ROWS.map((b) => ({ ...b }));
    }
    if (sql.includes("from claims c")) {
      const bars = new Map<string, string>(BAR_ROWS.map((b) => [b.id, b.name]));
      return (this.options.claims ?? []).map((c) => ({
        claim_id: c.id,
        team_id: c.teamId,
        bar_id: c.barId,
        bar_name: bars.get(c.barId) ?? "Unknown",
        claimed_at: c.claimedAt ?? "2024-01-01T11:30:00.000Z",
        revoked_at: null,
        revoked_reason: null,
      }));
    }
    if (sql.includes("from card_effect_awards")) {
      return (this.options.awards ?? []).map((a) => ({
        id: a.id,
        effect_id: a.effectId,
        team_id: a.teamId,
        kind: a.kind,
        claim_id: a.claimId,
        ledger_entry_id: a.ledgerEntryId,
        reversed_at: null,
        reversal_ledger_entry_id: null,
        created_at: "2024-01-01T11:40:00.000Z",
      }));
    }
    if (sql.includes("from score_ledger_entries")) {
      return (this.options.ledger ?? []).map((l) => ({
        id: l.id,
        team_id: l.teamId,
        bar_id: l.barId,
        category: l.category,
        points: l.points,
        source_claim_id: l.sourceClaimId ?? null,
        source_effect_id: l.sourceEffectId ?? null,
      }));
    }
    return undefined;
  }

  /** Post-process the shared fake's rows / observe writes it accepted. */
  private patch(
    sql: string,
    params: readonly unknown[],
    rows: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (sql.includes("from card_challenges")) {
      const failures = this.options.failureEffectIds ?? {};
      return rows.map((r) => ({
        ...r,
        failure_effect_id: failures[String(r.id)] ?? r.failure_effect_id,
      }));
    }
    if (sql.includes("from card_effects e")) {
      return rows.map((r) => {
        const done = this.cancelled.get(String(r.id));
        return {
          ...r,
          target_bar_key: r.target_bar_key ?? r.target_bar_id ?? null,
          ...(done === undefined
            ? {}
            : {
                cancelled_at: done.cancelledAt,
                cancel_reason: done.cancelReason,
              }),
        };
      });
    }
    if (
      sql.includes("update card_effects") &&
      sql.includes("cancel_reason = '")
    ) {
      const reason = sql.includes("'host'") ? "host" : "protection_released";
      this.cancelled.set(String(params[1]), {
        cancelledAt: NOW,
        cancelReason: reason,
      });
    }
    if (sql.includes("insert into card_effects") && params[18] != null) {
      this.cancelled.set(String(params[0]), {
        cancelledAt: String(params[18]),
        cancelReason: String(params[19]),
      });
    }
    return rows;
  }
}

/**
 * The claim blocks the Claim_Service would apply to `teamId` claiming `barKey`
 * against a loaded snapshot — the same input shape the claims route builds.
 */
export function claimBlocksFor(
  state: BehaviorState,
  teamId: string,
  barKey: string,
): ClaimBlock[] {
  const bar = state.bars.get(barKey);
  if (bar === undefined) throw new Error(`unknown bar ${barKey}`);
  const barCoords = new Map<string, LatLng>();
  for (const b of state.bars.values()) {
    if (b.coords !== null) barCoords.set(b.barKey, b.coords);
  }
  const start =
    state.startBarKey === null ? undefined : state.bars.get(state.startBarKey);
  const startRef: ResolvedBarRef = {
    barKey: start?.barKey ?? "",
    kind: "start",
    coords: start?.coords ?? null,
  };
  const previous = previousBarFor(teamId, state.claimHistory, startRef);
  const finish =
    state.finishBarKey === null
      ? undefined
      : state.bars.get(state.finishBarKey);
  return evaluateClaimBlocks({
    teamId,
    bar: { barKey: bar.barKey, kind: bar.kind, coords: bar.coords },
    finishCoords: finish?.coords ?? null,
    challenges: state.challenges,
    effects: state.effects,
    activeClaims: state.activeClaims.map((c) => ({
      teamId: c.teamId,
      barKey: c.barKey,
    })),
    previousBar: {
      ...previous,
      coords:
        previous.coords ?? state.bars.get(previous.barKey)?.coords ?? null,
    },
    barCoords,
    mode: "claim",
    nowMs: Date.parse(state.nowIso),
  });
}
