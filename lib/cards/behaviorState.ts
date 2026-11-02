/**
 * Shared behavior-state types (`lib/cards/behaviorState.ts`).
 *
 * Type-only, framework-free module. It is the canonical home for the vocabulary
 * the card-behavior planners share: the {@link StableError} result code, the
 * {@link Plan `Plan<T>`} planner result, the challenge/offer records and their
 * status unions, the durable {@link ClaimRow}/{@link PlayRow}/{@link AwardRecord}
 * row shapes read from the database, the {@link ResolvedBarRef} coordinate slice,
 * the {@link InventoryFollowUp} deck-transition rider, and the loaded
 * {@link BehaviorState} snapshot every pure planner takes.
 *
 * The timed-Effect vocabulary ({@link EffectRecord}, {@link EffectKind}) lives in
 * `./effects`; it is re-exported here so callers have a single import for the
 * behavior-state types. `challenges.ts` and `behaviorStore.ts` re-export these
 * types in turn.
 *
 * See design.md sections 6, 7, 8, and 15.
 */

import type { CastingParams } from "./inputs";
import type { CardInstance } from "./deck";
import type { CardSlug } from "./catalog";
import type { EffectRecord, EffectKind } from "./effects";
import type { ResolvedBar } from "@/lib/map/barResolver";
import type { LedgerEntry } from "@/lib/scoring/allocation";

// ---------------------------------------------------------------------------
// Shared result vocabulary.
//
// `effects.ts` (task 2.5) defined its own local `StableError`/`Plan<T>` before
// this module existed; those definitions were removed and now import from here,
// so these are the canonical declarations. The members match the Stable_Error
// vocabulary adopted by the routes (`app/api/games/_shared.ts`).
// ---------------------------------------------------------------------------

/**
 * The stable error codes a planner can reject with. Routes map these to HTTP
 * responses; the set never widens into free-form strings.
 */
export type StableError =
  | "not_authorized"
  | "invalid_input"
  | "conflict"
  | "blocked"
  | "expired"
  | "already_resolved"
  | "not_found"
  | "unavailable";

/**
 * A pure planner result: either an accepted `plan` payload, or a rejection with
 * a {@link StableError} and optional structured `details`.
 */
export type Plan<T> =
  | { readonly ok: true; readonly plan: T }
  | {
      readonly ok: false;
      readonly error: StableError;
      readonly details?: object;
    };

// ---------------------------------------------------------------------------
// Timed-effect vocabulary (owned by ./effects, re-exported for a single import).
// ---------------------------------------------------------------------------

export type { EffectRecord, EffectKind };

// ---------------------------------------------------------------------------
// Bar reference.
// ---------------------------------------------------------------------------

/**
 * The coordinate slice of a {@link ResolvedBar} the planners read: its
 * board-facing key, its scoring kind, and its coordinates (null when the bar has
 * no resolvable location, so distance-based rules treat it as off the map). A
 * full `ResolvedBar` is assignable to this.
 */
export interface ResolvedBarRef {
  readonly barKey: string;
  readonly kind: "start" | "finish" | "scoring";
  readonly coords: ResolvedBar["coords"];
}

// ---------------------------------------------------------------------------
// Challenge state machine (design.md section 7).
// ---------------------------------------------------------------------------

export type ChallengeStatus =
  "open" | "completed" | "failed" | "cleared_by_host";

/**
 * A durable challenge row (`card_challenges`). A challenge is created when a
 * gated team card is played; it carries the casting params, the Mirrored_Challenge
 * markers, and its resolution provenance.
 */
export interface ChallengeRecord {
  readonly challengeId: string;
  readonly slug: CardSlug;
  readonly sourcePlayId: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string;
  readonly params: CastingParams;
  readonly mirroredFromChallengeId: string | null; // Mirrored_Challenge marker
  readonly mirroredFromPlayId: string | null;
  readonly status: ChallengeStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedByTeamId: string | null;
  readonly resolvedBySessionId: string | null;
  readonly resolvedByKind: "team" | "host" | "system" | null;
  readonly failureEffectId: string | null;
}

// ---------------------------------------------------------------------------
// Fairest of Them All offers (design.md section 7).
// ---------------------------------------------------------------------------

export type FairestOfferStatus = "pending" | "played" | "declined" | "void";

/**
 * A durable Fairest-of-Them-All offer (`fairest_offers`). It is raised when a
 * mirrorable card targets a team holding Fairest; the offer references either the
 * gated challenge or the Pioneer/Scenic restriction it would mirror, never both.
 */
export interface FairestOfferRecord {
  readonly offerId: string;
  readonly sourcePlayId: string;
  readonly slug: CardSlug; // the mirrorable card
  readonly holderTeamId: string; // original target
  readonly originalCasterTeamId: string;
  readonly challengeId: string | null; // gated cards
  readonly restrictionEffectId: string | null; // Pioneer / Scenic
  readonly status: FairestOfferStatus;
  readonly decidedAt: string | null;
  readonly mirroredChallengeId: string | null;
  readonly mirroredEffectId: string | null;
}

// ---------------------------------------------------------------------------
// Score awards (design.md section 12, `card_effect_awards`).
// ---------------------------------------------------------------------------

/**
 * A durable card-effect award (`card_effect_awards`): a Happy Hour `+5` or a
 * Patient Investor `+6` paid into the score ledger. Awards are never part of a
 * bar's share holdings, so they survive reconciliation; `reversedAt` is set when
 * an ordinary unclaim reverses a Happy Hour bonus.
 */
export interface AwardRecord {
  readonly awardId: string;
  readonly effectId: string;
  readonly teamId: string;
  readonly kind: "happy_hour_bonus" | "patient_investor_award";
  readonly claimId: string | null; // null for a Bonus_Claim
  readonly ledgerEntryId: string;
  readonly reversedAt: string | null;
  readonly reversalLedgerEntryId: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Claim and play rows.
// ---------------------------------------------------------------------------

/**
 * A durable claim row (`claims`) in the shape the planners read: who claimed
 * which bar when, and the card-driven revocation reason (null while active). The
 * `barKey` is the board-facing key so claim history lines up with
 * {@link ResolvedBarRef}; `barId` is the foreign-keyed row identity.
 */
export interface ClaimRow {
  readonly claimId: string;
  readonly teamId: string;
  readonly barId: string;
  readonly barKey: string;
  readonly claimedAt: string;
  readonly revokedReason: "ordinary_unclaim" | "voted_off" | null;
}

/**
 * A durable card-play row (`card_plays`) in the shape the planners read: the
 * card played, its caster, its validated params, and the resolved target bar (for
 * bar-targeted cards). Plays are the `card_played` facts the same-name rule
 * counts, so Mirrored_Challenges (which have no play) never count against it.
 */
export interface PlayRow {
  readonly playId: string;
  readonly slug: CardSlug;
  readonly casterTeamId: string;
  readonly targetTeamId: string | null;
  readonly targetBarId: string | null;
  readonly targetBarKey: string | null;
  readonly params: CastingParams;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Inventory follow-up (design.md sections 7 and 15).
// ---------------------------------------------------------------------------

/**
 * The follow-up state changes that ride on a caster's deck transition when the
 * inventory settles: Use It or Lose It challenges that complete because the
 * team's hand and pending draw emptied, and Fairest offers voided because the
 * team no longer holds Fairest of Them All. `persistDeckTransition` merges these
 * into the inventory event so they commit with the hand change.
 */
export interface InventoryFollowUp {
  /** UIOLI challenges that complete as `resolvedByKind: "system"`. */
  readonly completeChallenges: readonly string[];
  /** Pending Fairest offers voided because the holder's hand lost Fairest. */
  readonly voidOffers: readonly string[];
}

// ---------------------------------------------------------------------------
// Loaded snapshot.
// ---------------------------------------------------------------------------

/**
 * The single, loaded-in-transaction snapshot every pure card-behavior planner
 * takes alongside a server time. `loadBehaviorState` builds it after the lazy
 * Timer_Sweep settles, so its flags reflect the current window state; planners
 * read it and never touch the database or a device clock.
 */
export interface BehaviorState {
  readonly gameId: string;
  readonly lifecycle: "lobby" | "live" | "ended";
  readonly nowIso: string;
  readonly teams: readonly {
    readonly teamId: string;
    readonly name: string;
    readonly memberSessionIds: readonly string[];
  }[];
  readonly hostSessionId: string;
  readonly bars: ReadonlyMap<string, ResolvedBar>; // by key, materialized + candidate
  readonly startBarKey: string | null;
  readonly finishBarKey: string | null;
  readonly activeClaims: readonly ClaimRow[];
  readonly claimHistory: readonly ClaimRow[];
  readonly hands: ReadonlyMap<
    string,
    {
      readonly hand: readonly CardInstance[];
      readonly pending: readonly CardInstance[];
    }
  >;
  readonly plays: readonly PlayRow[];
  readonly challenges: readonly ChallengeRecord[];
  readonly offers: readonly FairestOfferRecord[];
  readonly effects: readonly EffectRecord[];
  readonly awards: readonly AwardRecord[];
  readonly ledger: readonly LedgerEntry[];
}
