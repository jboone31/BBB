/**
 * Card-play planner (`lib/cards/playPlan.ts`).
 *
 * Pure, framework-free module. {@link planCardPlay} is the single rule engine for
 * "a team plays a card": it validates the request against a loaded
 * {@link BehaviorState} plus a server time and returns a {@link PlayPlan} the
 * play route writes in one transaction, or a {@link StableError} rejection. It
 * never touches the database, a device clock, or announced flags.
 *
 * Validation order (design.md section 8):
 *   1. the game is live (`conflict`);
 *   2. the card is in the caster's hand (`conflict`);
 *   3. the card is not Fairest of Them All played as a normal play
 *      (`invalid_input` — Fairest is reactive, played only through a Fairest
 *      offer decision);
 *   4. the casting input validates via {@link validateCastingInput}
 *      (`invalid_input`);
 *   5. the request supplies the target mode the card needs (`invalid_input`);
 *   6. the target is eligible via the shared 3.12 selectors (`invalid_input`),
 *      so UI and server agree on who/what may be targeted; and finally
 *   7. the per-card resolver builds the durable records.
 *
 * The per-card resolvers (keyed by slug) mirror the design's registry table:
 *
 * - **Gated team cards** (the 11 challenges) open a {@link ChallengeRecord}. A
 *   Use It or Lose It challenge is created `completed` (by `system`) when the
 *   target's hand and pending draw are already empty. When the target holds
 *   Fairest of Them All and the play is not itself a mirror, a pending
 *   {@link FairestOfferRecord} is raised.
 * - **Pioneer / Scenic Route** create a `next_claim_restriction` effect on the
 *   target. A target with no Legal_Next_Bar for its active rules plus the new
 *   rule is rejected with `invalid_input`, details `{ reason: "no_legal_next_bar",
 *   rules }`, and the card stays in the caster's hand (the same reason the 3.12
 *   selector reports). A Fairest offer is raised only when the target holds
 *   Fairest, the play is not a mirror, and `mirrorIsLegal` holds for the original
 *   caster at the play's `now`; otherwise the play succeeds with no offer.
 * - **Crop Dusting** adds a `bar_lock` `[now, now+15m)` owned by the caster.
 * - **Cancel Culture** adds a `radius_lock` `[now+15m, now+30m)` with
 *   `params.radiusMiles = 0.25`.
 * - **Happy Hour** adds a `bonus_window` `[now, now+60m)`.
 * - **Party Crasher** adds a `phantom_share` (no end) and reconciles the bar.
 * - **Insurance** adds an unattached `score_protection` owned by the caster.
 * - **Patient Investor** adds a `claim_counter` owned by the caster with
 *   `params.counted = []`.
 * - **Power Hour** adds a `draw_override` `[now, now+20m)`.
 * - **Voted Off the Island** revokes the target's active claim on the bar
 *   (`voted_off`), releases any Insurance attached to that claim, reconciles the
 *   bar, and opens no challenge.
 *
 * Insurance, Patient Investor, and Power Hour accept no target; the validated
 * casting params are stored on the play (and, for gated cards, on the challenge).
 *
 * Requirements: 4.1, 6.4, 6.5, 8.1, 8.6, 9.1, 9.11, 9.14, 9.15, 10.1, 10.3,
 * 10.10, 10.11, 11.1, 11.2, 12.1, 12.3, 13.1, 13.2, 14.1, 14.4, 14.6, 15.1,
 * 16.1, 17.1, 18.2, 18.4, 18.5, 22.1-22.5.
 */

import { getCardMetadata, isGatedCard, type CardSlug } from "./catalog";
import { validateCastingInput, type CastingParams } from "./inputs";
import { DURATIONS_MS, type EffectRecord } from "./effects";
import { useItOrLoseItShouldComplete } from "./challenges";
import {
  mirrorIsLegal,
  previousBarFor,
  type NextClaimRule,
} from "@/lib/claims/legalNextBar";
import {
  selectBarTargetEligibility,
  selectTeamTargetEligibility,
  type CardTargetContext,
} from "@/lib/gameboard/cardEligibility";
import {
  initialGameBoardView,
  type BoardCardPlayView,
  type BoardTeamView,
  type GameBoardView,
} from "@/lib/gameboard/events";
import type { ClaimState } from "@/lib/map/claims";
import { CANCEL_CULTURE_RADIUS_MILES, type LatLng } from "@/lib/map/geo";
import type {
  BehaviorState,
  ChallengeRecord,
  FairestOfferRecord,
  InventoryFollowUp,
  Plan,
  ResolvedBarRef,
} from "./behaviorState";

// ---------------------------------------------------------------------------
// Request / plan payloads.
// ---------------------------------------------------------------------------

/**
 * A request to play one card. `cardId` is the engine instance id
 * (`${teamId}:${slug}`); `rawParams` is the untrusted casting input body, which
 * {@link validateCastingInput} turns into {@link CastingParams}. `targetTeamId`
 * and `targetBarKey` are present only for the dimensions the card targets.
 */
export interface PlayRequest {
  readonly cardId: string;
  readonly casterTeamId: string;
  readonly targetTeamId?: string;
  readonly targetBarKey?: string;
  readonly rawParams?: unknown;
}

/**
 * The durable records a single play produces, applied by the play route in one
 * transaction (design.md section 8). Every list is a set of inserts/updates; an
 * empty list means the card touches that dimension not at all.
 */
export interface PlayPlan {
  readonly slug: CardSlug;
  readonly params: CastingParams;
  readonly targetBar: ResolvedBarRef | null;
  readonly challenges: readonly ChallengeRecord[];
  readonly offers: readonly FairestOfferRecord[];
  readonly effects: readonly EffectRecord[];
  readonly revokeClaims: readonly {
    readonly claimId: string;
    readonly reason: "voted_off";
  }[];
  readonly releaseProtections: readonly string[]; // effect ids
  readonly reconcileBars: readonly string[]; // bar keys
  readonly inventoryFollowUp: InventoryFollowUp; // caster's own hand change
  /**
   * The board key of the bar a Spin Cycle target must return to — the target
   * team's most recently claimed bar, or the start bar when it has none
   * (18.x). Resolved at play time so the toast can name it. Null for every other
   * card. Kept separate from `targetBar`/`targetBarKey`, which drive the
   * same-name-once rule and the bar-headline templates.
   */
  readonly returnBarKey: string | null;
}

// ---------------------------------------------------------------------------
// Slug constants.
// ---------------------------------------------------------------------------

const FAIREST_SLUG: CardSlug = "fairest-of-them-all";
const UIOLI_SLUG: CardSlug = "use-it-or-lose-it";
const SPIN_CYCLE_SLUG: CardSlug = "spin-cycle";
const PIONEER_SLUG: CardSlug = "pioneer";
const SCENIC_SLUG: CardSlug = "scenic-route";

/** Whether a slug is a Pioneer/Scenic next-claim restriction (mirrors as an effect). */
function isRestrictionSlug(slug: CardSlug): slug is "pioneer" | "scenic-route" {
  return slug === PIONEER_SLUG || slug === SCENIC_SLUG;
}

/** The next-claim rule a restriction slug imposes. */
function ruleForSlug(slug: "pioneer" | "scenic-route"): NextClaimRule {
  return slug === PIONEER_SLUG ? "pioneer" : "scenic";
}

// ---------------------------------------------------------------------------
// Time helpers.
// ---------------------------------------------------------------------------

/** Add `ms` to an ISO server timestamp and return the ISO result. */
function addMsIso(nowMs: number, ms: number): string {
  return new Date(nowMs + ms).toISOString();
}

// ---------------------------------------------------------------------------
// Deterministic ids.
//
// The planner is pure, so every id it mints is a deterministic derivation of the
// stable play identity plus a per-record discriminator. This mirrors the
// derivation in `persistence.ts`/`challenges.ts` so repeated planning of the same
// request yields the same ids without a database round-trip.
// ---------------------------------------------------------------------------

/**
 * Derive a stable UUID (v4-shaped) from a name string via a small FNV-1a hash
 * expanded to 16 bytes. The same name always yields the same id.
 */
function deterministicUuid(name: string): string {
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i += 1) {
    for (let j = 0; j < name.length; j += 1) {
      h ^= name.charCodeAt(j) + i * 131;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes[i] = h & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

/**
 * The stable source-play id for this request. The play route assigns the real
 * `card_plays` row id, but the planner needs a value to thread into the challenge/
 * offer/effect records it mints; the route rewrites the links when it persists.
 */
function sourcePlayIdFor(
  state: BehaviorState,
  req: PlayRequest,
  now: string,
): string {
  return deterministicUuid(
    `play:${state.gameId}:${req.casterTeamId}:${req.cardId}:${now}`,
  );
}

// ---------------------------------------------------------------------------
// View / context builders.
// ---------------------------------------------------------------------------

/**
 * Build the minimal {@link GameBoardView} the eligibility selectors read from a
 * loaded {@link BehaviorState}: the team roster and the `card_played` targeting
 * facts (the same-name rule counts only plays, so Mirrored_Challenges — which
 * have no play row — never count against it, 9.14). Bar targeting is keyed by the
 * board-facing bar key throughout, so `targetBarId` carries the play's
 * `targetBarKey`.
 */
function buildView(state: BehaviorState): GameBoardView {
  const teams: BoardTeamView[] = state.teams.map((team) => ({
    id: team.teamId,
    name: team.name,
    color: "#000000",
  }));

  const cardPlays: BoardCardPlayView[] = state.plays.map((play, index) => ({
    seq: index + 1,
    slug: play.slug,
    castingTeamId: play.casterTeamId,
    targetTeamId: play.targetTeamId,
    targetBarId: play.targetBarKey,
  }));

  return { ...initialGameBoardView(state.gameId), teams, cardPlays };
}

/** The claim state keyed by bar key: bar key -> active claimant team ids. */
function buildClaimState(state: BehaviorState): ClaimState {
  const claimState: Record<string, string[]> = {};
  for (const claim of state.activeClaims) {
    (claimState[claim.barKey] ??= []).push(claim.teamId);
  }
  return claimState;
}

/** The bar-coordinate map keyed by bar key, for distance-based rules. */
function buildBarCoords(state: BehaviorState): ReadonlyMap<string, LatLng> {
  const coords = new Map<string, LatLng>();
  for (const bar of state.bars.values()) {
    if (bar.coords !== null) {
      coords.set(bar.barKey, bar.coords);
    }
  }
  return coords;
}

/**
 * Each team's unconsumed, uncancelled `next_claim_restriction` rules, keyed by
 * team id, for the Pioneer/Scenic Legal_Next_Bar check in the team selector.
 */
function buildRestrictions(
  state: BehaviorState,
): ReadonlyMap<string, readonly NextClaimRule[]> {
  const restrictions = new Map<string, NextClaimRule[]>();
  for (const effect of state.effects) {
    if (effect.kind !== "next_claim_restriction") {
      continue;
    }
    if (effect.targetTeamId === null) {
      continue;
    }
    if (effect.consumedAt !== null || effect.cancelledAt !== null) {
      continue;
    }
    const rule = effect.params.rule;
    if (rule !== "pioneer" && rule !== "scenic") {
      continue;
    }
    (
      restrictions.get(effect.targetTeamId) ??
      (() => {
        const list: NextClaimRule[] = [];
        restrictions.set(effect.targetTeamId, list);
        return list;
      })()
    ).push(rule);
  }
  return restrictions;
}

/** Each team's previous bar, keyed by team id, for Scenic's Legal_Next_Bar check. */
function buildPreviousBars(
  state: BehaviorState,
): ReadonlyMap<string, ResolvedBarRef> {
  const startBar = startBarRef(state);
  const previous = new Map<string, ResolvedBarRef>();
  for (const team of state.teams) {
    const ref = previousBarFor(team.teamId, state.claimHistory, startBar);
    // Resolve a non-start previous bar's coordinates from the bar set so Scenic
    // distance can be computed.
    const resolved: ResolvedBarRef =
      ref.coords === null && ref.barKey !== ""
        ? { ...ref, coords: state.bars.get(ref.barKey)?.coords ?? null }
        : ref;
    previous.set(team.teamId, resolved);
  }
  return previous;
}

/** The start bar as a {@link ResolvedBarRef}, or an empty placeholder when unknown. */
function startBarRef(state: BehaviorState): ResolvedBarRef {
  if (state.startBarKey !== null && state.bars.has(state.startBarKey)) {
    const bar = state.bars.get(state.startBarKey)!;
    return { barKey: bar.barKey, kind: bar.kind, coords: bar.coords };
  }
  return { barKey: "", kind: "start", coords: null };
}

/** Build the shared {@link CardTargetContext} from a loaded state. */
function buildContext(state: BehaviorState): CardTargetContext {
  return {
    finishBarKey: state.finishBarKey,
    startBarKey: state.startBarKey,
    barCoords: buildBarCoords(state),
    claimState: buildClaimState(state),
    teamIds: state.teams.map((team) => team.teamId),
    previousBars: buildPreviousBars(state),
    restrictions: buildRestrictions(state),
  };
}

// ---------------------------------------------------------------------------
// An empty plan skeleton for a resolver to extend.
// ---------------------------------------------------------------------------

interface ResolverContext {
  readonly state: BehaviorState;
  readonly req: PlayRequest;
  readonly now: string;
  readonly nowMs: number;
  readonly slug: CardSlug;
  readonly params: CastingParams;
  readonly sourcePlayId: string;
  readonly targetTeamId: string | null;
  readonly targetBar: ResolvedBarRef | null;
}

function emptyPlan(
  slug: CardSlug,
  params: CastingParams,
  targetBar: ResolvedBarRef | null,
): PlayPlan {
  return {
    slug,
    params,
    targetBar,
    challenges: [],
    offers: [],
    effects: [],
    revokeClaims: [],
    releaseProtections: [],
    reconcileBars: [],
    inventoryFollowUp: { completeChallenges: [], voidOffers: [] },
    returnBarKey: null,
  };
}

/** Whether the caster still holds Fairest of Them All in hand in the loaded state. */
function targetHoldsFairest(state: BehaviorState, teamId: string): boolean {
  const inventory = state.hands.get(teamId);
  return inventory?.hand.some((card) => card.slug === FAIREST_SLUG) ?? false;
}

/** The caster's hand/pending counts, for UIOLI immediate completion. */
function inventoryCounts(
  state: BehaviorState,
  teamId: string,
): { hand: number; pending: number } {
  const inventory = state.hands.get(teamId);
  return {
    hand: inventory?.hand.length ?? 0,
    pending: inventory?.pending.length ?? 0,
  };
}

/** Build a base (no-end) effect record; callers set `kind`-specific fields. */
function baseEffect(
  effectId: string,
  slug: CardSlug,
  kind: EffectRecord["kind"],
  sourcePlayId: string,
  now: string,
): EffectRecord {
  return {
    effectId,
    slug,
    kind,
    sourcePlayId,
    sourceChallengeId: null,
    ownerTeamId: null,
    targetTeamId: null,
    targetBarKey: null,
    startsAt: now,
    endsAt: null,
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
  };
}

// ---------------------------------------------------------------------------
// Resolvers.
// ---------------------------------------------------------------------------

/**
 * A gated team challenge (Go Piss Girl, Moneybags, Use It or Lose It, Wired, Art
 * School Dropout, Broad Shoulders, Bird Guide, Interested Buyer, Different
 * Tastes, Everyone's a Critic, Spin Cycle, Dirty Bird). Opens a challenge on the
 * target; UIOLI is created `completed` (`system`) when the target's hand and
 * pending draw are empty; a pending Fairest offer is raised when the target holds
 * Fairest and this play is not itself a mirror.
 */
function resolveGatedTeam(ctx: ResolverContext): Plan<PlayPlan> {
  const { state, now, slug, params, sourcePlayId, targetTeamId } = ctx;
  // The target mode check guarantees a team target here.
  const target = targetTeamId as string;

  const challengeId = deterministicUuid(`challenge:${sourcePlayId}:${target}`);

  let status: ChallengeRecord["status"] = "open";
  let resolvedAt: string | null = null;
  let resolvedByKind: ChallengeRecord["resolvedByKind"] = null;
  if (slug === UIOLI_SLUG) {
    const counts = inventoryCounts(state, target);
    if (useItOrLoseItShouldComplete(counts.hand, counts.pending)) {
      status = "completed";
      resolvedAt = now;
      resolvedByKind = "system";
    }
  }

  const challenge: ChallengeRecord = {
    challengeId,
    slug,
    sourcePlayId,
    casterTeamId: ctx.req.casterTeamId,
    targetTeamId: target,
    params,
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status,
    createdAt: now,
    resolvedAt,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind,
    failureEffectId: null,
  };

  const offers = maybeOffer(ctx, { challengeId, restrictionEffectId: null });

  // Spin Cycle sends the target back to the bar it most recently claimed, so
  // resolve that bar now (excluding ordinary unclaims, keeping voted_off, and
  // falling back to the start bar when the team has no qualifying claim) and
  // record its key so the toast can name it (18.x).
  const returnBarKey =
    slug === SPIN_CYCLE_SLUG
      ? previousBarFor(target, state.claimHistory, startBarRef(state)).barKey
      : null;

  return {
    ok: true,
    plan: {
      ...emptyPlan(slug, params, null),
      challenges: [challenge],
      offers,
      returnBarKey,
    },
  };
}

/**
 * Pioneer / Scenic Route. Creates a `next_claim_restriction` on the target. The
 * target eligibility check already rejected a target with no Legal_Next_Bar, so
 * reaching here means the restriction is addable. A Fairest offer is raised only
 * when the target holds Fairest, the play is not a mirror, and the mirror back
 * onto the caster would still leave the caster a Legal_Next_Bar at `now`.
 */
function resolveRestriction(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, slug, params, sourcePlayId, targetTeamId } = ctx;
  const target = targetTeamId as string;
  const restrictionSlug = slug as "pioneer" | "scenic-route";
  const rule = ruleForSlug(restrictionSlug);

  const effectId = deterministicUuid(`restriction:${sourcePlayId}:${target}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "next_claim_restriction", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    targetTeamId: target,
    params: { rule },
  };

  const offers = maybeOffer(ctx, {
    challengeId: null,
    restrictionEffectId: effectId,
  });

  return {
    ok: true,
    plan: {
      ...emptyPlan(slug, params, null),
      effects: [effect],
      offers,
    },
  };
}

/**
 * Build the pending Fairest offer for a mirrorable team card, or an empty list.
 * An offer is raised only when the target holds Fairest and the play is not a
 * mirror; for Pioneer/Scenic it is additionally gated on `mirrorIsLegal` for the
 * original caster at `now` (9.15). The source play has no mirror marker, so a
 * fresh play is never itself a mirror.
 */
function maybeOffer(
  ctx: ResolverContext,
  link: { challengeId: string | null; restrictionEffectId: string | null },
): FairestOfferRecord[] {
  const { state, now, slug, sourcePlayId, targetTeamId } = ctx;
  const target = targetTeamId as string;

  if (!targetHoldsFairest(state, target)) {
    return [];
  }

  if (isRestrictionSlug(slug)) {
    // The mirror would add this rule to the original caster's active rules; only
    // offer when the caster would still have a Legal_Next_Bar.
    const legal = mirrorIsLegal(
      state,
      { slug, originalCasterTeamId: ctx.req.casterTeamId },
      now,
    );
    if (!legal) {
      return [];
    }
  }

  const offerId = deterministicUuid(`offer:${sourcePlayId}:${target}`);
  return [
    {
      offerId,
      sourcePlayId,
      slug,
      holderTeamId: target,
      originalCasterTeamId: ctx.req.casterTeamId,
      challengeId: link.challengeId,
      restrictionEffectId: link.restrictionEffectId,
      status: "pending",
      decidedAt: null,
      mirroredChallengeId: null,
      mirroredEffectId: null,
    },
  ];
}

/** Crop Dusting: a `bar_lock` owned by the caster for `[now, now+15m)`. */
function resolveCropDusting(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, nowMs, slug, params, sourcePlayId, targetBar } = ctx;
  const bar = targetBar as ResolvedBarRef;
  const effectId = deterministicUuid(`bar-lock:${sourcePlayId}:${bar.barKey}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "bar_lock", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    targetBarKey: bar.barKey,
    endsAt: addMsIso(nowMs, DURATIONS_MS.cropDusting),
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, bar), effects: [effect] },
  };
}

/**
 * Cancel Culture: a delayed `radius_lock` `[now+15m, now+30m)` with
 * `params.radiusMiles = 0.25`. It starts unannounced (its start toast fires at
 * the delayed boundary), so `startAnnounced` is false.
 */
function resolveCancelCulture(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, nowMs, slug, params, sourcePlayId, targetBar } = ctx;
  const bar = targetBar as ResolvedBarRef;
  const startsAt = addMsIso(nowMs, DURATIONS_MS.cancelCultureDelay);
  const endsAt = addMsIso(
    nowMs,
    DURATIONS_MS.cancelCultureDelay + DURATIONS_MS.cancelCultureLock,
  );
  const effectId = deterministicUuid(
    `radius-lock:${sourcePlayId}:${bar.barKey}`,
  );
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "radius_lock", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    targetBarKey: bar.barKey,
    startsAt,
    endsAt,
    params: { radiusMiles: CANCEL_CULTURE_RADIUS_MILES },
    startAnnounced: false,
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, bar), effects: [effect] },
  };
}

/** Happy Hour: a `bonus_window` `[now, now+60m)`. */
function resolveHappyHour(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, nowMs, slug, params, sourcePlayId, targetBar } = ctx;
  const bar = targetBar as ResolvedBarRef;
  const effectId = deterministicUuid(
    `bonus-window:${sourcePlayId}:${bar.barKey}`,
  );
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "bonus_window", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    targetBarKey: bar.barKey,
    endsAt: addMsIso(nowMs, DURATIONS_MS.happyHour),
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, bar), effects: [effect] },
  };
}

/** Party Crasher: a `phantom_share` (no end) plus a reconcile of the bar. */
function resolvePartyCrasher(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, slug, params, sourcePlayId, targetBar } = ctx;
  const bar = targetBar as ResolvedBarRef;
  const effectId = deterministicUuid(`phantom:${sourcePlayId}:${bar.barKey}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "phantom_share", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    targetBarKey: bar.barKey,
  };
  return {
    ok: true,
    plan: {
      ...emptyPlan(slug, params, bar),
      effects: [effect],
      reconcileBars: [bar.barKey],
    },
  };
}

/** Insurance: an unattached `score_protection` owned by the caster. */
function resolveInsurance(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, slug, params, sourcePlayId } = ctx;
  const effectId = deterministicUuid(`insurance:${sourcePlayId}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "score_protection", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, null), effects: [effect] },
  };
}

/** Patient Investor: a `claim_counter` owned by the caster with `counted: []`. */
function resolvePatientInvestor(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, slug, params, sourcePlayId } = ctx;
  const effectId = deterministicUuid(`counter:${sourcePlayId}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "claim_counter", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    params: { counted: [] },
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, null), effects: [effect] },
  };
}

/** Power Hour: a `draw_override` `[now, now+20m)`. */
function resolvePowerHour(ctx: ResolverContext): Plan<PlayPlan> {
  const { now, nowMs, slug, params, sourcePlayId } = ctx;
  const effectId = deterministicUuid(`draw-override:${sourcePlayId}`);
  const effect: EffectRecord = {
    ...baseEffect(effectId, slug, "draw_override", sourcePlayId, now),
    ownerTeamId: ctx.req.casterTeamId,
    endsAt: addMsIso(nowMs, DURATIONS_MS.powerHour),
  };
  return {
    ok: true,
    plan: { ...emptyPlan(slug, params, null), effects: [effect] },
  };
}

/**
 * Voted Off the Island: revoke the target team's active claim on the target bar
 * (`voted_off`), release any Insurance attached to that claim, reconcile the bar,
 * and open no challenge (18.4, 18.5).
 */
function resolveVotedOff(ctx: ResolverContext): Plan<PlayPlan> {
  const { state, slug, params, targetTeamId, targetBar } = ctx;
  const target = targetTeamId as string;
  const bar = targetBar as ResolvedBarRef;

  const claim = state.activeClaims.find(
    (c) => c.teamId === target && c.barKey === bar.barKey,
  );
  if (claim === undefined) {
    // The eligibility selector requires every team to hold the bar, so this is
    // only reachable if the loaded state disagrees; reject rather than write a
    // partial plan.
    return { ok: false, error: "invalid_input" };
  }

  // Release any Insurance attached to the revoked claim.
  const releaseProtections: string[] = [];
  for (const effect of state.effects) {
    if (
      effect.kind === "score_protection" &&
      effect.attachedClaimId === claim.claimId &&
      effect.cancelledAt === null &&
      effect.consumedAt === null
    ) {
      releaseProtections.push(effect.effectId);
    }
  }

  return {
    ok: true,
    plan: {
      ...emptyPlan(slug, params, bar),
      revokeClaims: [{ claimId: claim.claimId, reason: "voted_off" }],
      releaseProtections,
      reconcileBars: [bar.barKey],
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver registry.
// ---------------------------------------------------------------------------

type Resolver = (ctx: ResolverContext) => Plan<PlayPlan>;

const RESOLVERS: Partial<Record<CardSlug, Resolver>> = {
  "crop-dusting": resolveCropDusting,
  "cancel-culture": resolveCancelCulture,
  pioneer: resolveRestriction,
  "scenic-route": resolveRestriction,
  "happy-hour": resolveHappyHour,
  "party-crasher": resolvePartyCrasher,
  insurance: resolveInsurance,
  "patient-investor": resolvePatientInvestor,
  "power-hour": resolvePowerHour,
  "voted-off-the-island": resolveVotedOff,
};

// ---------------------------------------------------------------------------
// planCardPlay.
// ---------------------------------------------------------------------------

/**
 * Plan a card play against a loaded {@link BehaviorState} and a server time.
 * Returns the {@link PlayPlan} the play route writes, or a {@link StableError}
 * rejection. The validation order and per-card resolvers follow design.md section
 * 8; a rejection writes nothing (including leaving a Pioneer/Scenic card in the
 * caster's hand).
 */
export function planCardPlay(
  state: BehaviorState,
  req: PlayRequest,
  now: string,
): Plan<PlayPlan> {
  // 1. The game must be live.
  if (state.lifecycle !== "live") {
    return { ok: false, error: "conflict" };
  }

  // 2. The card must be in the caster's hand.
  const inventory = state.hands.get(req.casterTeamId);
  const held = inventory?.hand.find((card) => card.id === req.cardId);
  if (held === undefined) {
    return { ok: false, error: "conflict" };
  }
  const slug = held.slug;

  // 3. Fairest of Them All is reactive — it is never played as a normal play.
  if (slug === FAIREST_SLUG) {
    return { ok: false, error: "invalid_input" };
  }

  const meta = getCardMetadata(slug);

  // 4. Casting input.
  const validation = validateCastingInput(meta.castingInput, req.rawParams);
  if (!validation.ok) {
    return { ok: false, error: "invalid_input" };
  }
  const params = validation.params;

  // 5. Target mode: the request must supply the dimensions the card targets.
  const needsTeam =
    meta.targetMode === "team" || meta.targetMode === "team_and_bar";
  const needsBar =
    meta.targetMode === "bar" || meta.targetMode === "team_and_bar";

  if (needsTeam && req.targetTeamId === undefined) {
    return { ok: false, error: "invalid_input" };
  }
  if (needsBar && req.targetBarKey === undefined) {
    return { ok: false, error: "invalid_input" };
  }
  // Self/none cards must not carry a team/bar target.
  if (!needsTeam && req.targetTeamId !== undefined) {
    return { ok: false, error: "invalid_input" };
  }
  if (!needsBar && req.targetBarKey !== undefined) {
    return { ok: false, error: "invalid_input" };
  }

  // 6. Target eligibility via the shared selectors.
  const view = buildView(state);
  const targetCtx = buildContext(state);

  let targetBar: ResolvedBarRef | null = null;
  if (needsBar) {
    const barKey = req.targetBarKey as string;
    const resolved = state.bars.get(barKey);
    if (resolved === undefined) {
      return { ok: false, error: "invalid_input" };
    }
    targetBar = {
      barKey: resolved.barKey,
      kind: resolved.kind,
      coords: resolved.coords,
    };
    const [eligibility] = selectBarTargetEligibility(
      view,
      slug,
      [barKey],
      targetCtx,
    );
    if (eligibility === undefined || !eligibility.eligible) {
      return { ok: false, error: "invalid_input" };
    }
  }

  let targetTeamId: string | null = null;
  if (needsTeam) {
    const team = req.targetTeamId as string;
    const eligibility = selectTeamTargetEligibility(
      view,
      slug,
      req.casterTeamId,
      targetCtx,
    ).find((entry) => entry.teamId === team);
    if (eligibility === undefined || !eligibility.eligible) {
      // Pioneer/Scenic surface the Legal_Next_Bar reason so the route can relay
      // `{ reason: "no_legal_next_bar", rules }`; other reasons are plain
      // invalid_input.
      if (eligibility?.reason === "no_legal_next_bar") {
        return {
          ok: false,
          error: "invalid_input",
          details: {
            reason: "no_legal_next_bar",
            rules: eligibility.rules ?? [],
          },
        };
      }
      return { ok: false, error: "invalid_input" };
    }
    targetTeamId = team;
  }

  // 7. Per-card resolver.
  const resolverCtx: ResolverContext = {
    state,
    req,
    now,
    nowMs: Date.parse(now),
    slug,
    params,
    sourcePlayId: sourcePlayIdFor(state, req, now),
    targetTeamId,
    targetBar,
  };

  const resolver = RESOLVERS[slug];
  if (resolver !== undefined) {
    return resolver(resolverCtx);
  }

  // The default resolver covers every gated team card (the 11 challenges). Any
  // slug that reaches here that is not a gated team card is a configuration bug.
  if (isGatedCard(meta)) {
    return resolveGatedTeam(resolverCtx);
  }

  return { ok: false, error: "invalid_input" };
}
