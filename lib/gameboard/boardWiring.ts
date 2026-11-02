/**
 * Board-page wiring helpers for card behavior (card-behavior task 10.6).
 *
 * Pure, framework-free glue between the folded {@link GameBoardView} and the
 * board UI components (`ToastStack`, `MapRegion`, `BarLeafletMap`). The board
 * page (`app/games/[gameId]/board/page.tsx`) calls these on every render so the
 * toast stack, claim-block pre-check, map overlays, and Fairest mirror check are
 * all recomputed from the current projection (Requirements 3.9, 4.5, 13.4).
 *
 *   - {@link buildSelectorContext}: the {@link CardBehaviorSelectorContext} the
 *     card-behavior selectors read, built from the candidate bars and the folded
 *     active claims.
 *   - {@link mirrorIsLegalInView}: the client-side Fairest mirror-legality check
 *     for the Pioneer / Scenic Route prompt (9.18), reusing `hasLegalNextBar`.
 *   - {@link composeBoardToasts}: `deriveToasts` plus the pending actions from
 *     `selectPendingActions` (attached to the toast they belong to, or a Fairest
 *     prompt toast), filtered by the per-game dismissal record and merged with
 *     the Boundary_Toasts in a `Map` keyed by toast id, so re-deriving never
 *     duplicates a visible toast.
 *   - Dismissal storage: the per-game `{ floorSeq, dismissed }` record kept in
 *     localStorage, shared by the event toasts and the Boundary_Toasts.
 */

import type {
  FairestOfferRecord,
  ResolvedBarRef,
} from "@/lib/cards/behaviorState";
import { getCardMetadata, getCardText } from "@/lib/cards/catalog";
import { isEffectActive } from "@/lib/cards/effects";
import { renderTemplate } from "@/lib/cards/templates";
import {
  deriveToasts,
  selectPendingActions,
  type Toast,
  type ToastAction,
  type ToastDismissalRecord,
} from "@/lib/cards/toasts";
import { hasLegalNextBar, type NextClaimRule } from "@/lib/claims/legalNextBar";
import type { CardBehaviorSelectorContext } from "@/lib/gameboard/cardBehavior";
import type { CardTargetContext } from "@/lib/gameboard/cardEligibility";
import type { GameBoardView } from "@/lib/gameboard/events";
import { CANDIDATE_BARS, type CandidateBar } from "@/lib/map/bars";
import type { LatLng } from "@/lib/map/geo";

// ---------------------------------------------------------------------------
// Selector context.
// ---------------------------------------------------------------------------

/**
 * Build the selector context from the candidate bars and the folded claims.
 *
 * The board does not know which candidate bar is the game's start or finish bar
 * (designations reference game bar rows, not candidate keys), so every bar is a
 * `scoring` bar and `finishCoords` is null here. The server remains the
 * authority: a claim the pre-check allows can still come back `blocked`, and the
 * board then shows the server's blocks. A team's previous bar is its most
 * recently folded active claim.
 */
export function buildSelectorContext(
  view: GameBoardView,
  bars: readonly CandidateBar[] = CANDIDATE_BARS,
): CardBehaviorSelectorContext {
  const barMap = new Map<string, ResolvedBarRef>();
  for (const bar of bars) {
    barMap.set(bar.id, {
      barKey: bar.id,
      kind: "scoring",
      coords: { lat: bar.lat, lng: bar.lng },
    });
  }

  const activeClaims = view.activeClaims.map((claim) => ({
    teamId: claim.teamId,
    barKey: claim.barId,
  }));

  // Folded claims are appended in seq order, so the last one per team is the
  // team's most recent active claim.
  const previousBarByTeam = new Map<string, ResolvedBarRef>();
  for (const claim of view.activeClaims) {
    const ref = barMap.get(claim.barId);
    if (ref !== undefined) {
      previousBarByTeam.set(claim.teamId, ref);
    }
  }

  return {
    bars: barMap,
    finishCoords: null,
    activeClaims,
    previousBarByTeam,
  };
}

// ---------------------------------------------------------------------------
// Fairest mirror legality (client side).
// ---------------------------------------------------------------------------

function ruleForSlug(slug: string): NextClaimRule | null {
  if (slug === "pioneer") {
    return "pioneer";
  }
  if (slug === "scenic-route") {
    return "scenic";
  }
  return null;
}

/**
 * Whether mirroring `offer` back onto its original caster is still legal in the
 * current view at `serverNowMs` (9.17, 9.18). Non-restriction cards are always
 * mirrorable. For Pioneer / Scenic Route, the original caster must keep at least
 * one Legal_Next_Bar once the mirrored rule joins its own active restrictions;
 * this mirrors `mirrorIsLegal` in `lib/claims/legalNextBar.ts` over the board's
 * projection instead of a server snapshot.
 */
export function mirrorIsLegalInView(
  view: GameBoardView,
  ctx: CardBehaviorSelectorContext,
  offer: Pick<FairestOfferRecord, "slug" | "originalCasterTeamId">,
  serverNowMs: number,
): boolean {
  const rule = ruleForSlug(offer.slug);
  if (rule === null) {
    return true;
  }
  const casterId = offer.originalCasterTeamId;

  const rules: NextClaimRule[] = [];
  for (const effect of Object.values(view.cardBehavior.effects)) {
    if (
      effect.kind !== "next_claim_restriction" ||
      effect.targetTeamId !== casterId ||
      !isEffectActive(effect, serverNowMs)
    ) {
      continue;
    }
    const existing = effect.params.rule;
    if (existing === "pioneer" || existing === "scenic") {
      rules.push(existing);
    }
  }
  rules.push(rule);

  return hasLegalNextBar({
    teamId: casterId,
    rules,
    bars: [...ctx.bars.values()],
    finishCoords: ctx.finishCoords,
    activeClaims: ctx.activeClaims,
    previousBar: ctx.previousBarByTeam.get(casterId) ?? {
      barKey: "",
      kind: "start",
      coords: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Card-targeting context for the play panel.
// ---------------------------------------------------------------------------

/**
 * The {@link CardTargetContext} the Card_Play_Panel passes to the targeting
 * selectors, built from the same board facts as {@link buildSelectorContext}
 * (10.12, 22.5). It carries bar coordinates, the folded claim state, every
 * team's previous bar (the start bar when the team has no active claim, as in
 * {@link mirrorIsLegalInView}), and each team's active Pioneer / Scenic rules,
 * so the picker can gray out a team that would be left with no Legal_Next_Bar.
 * The finish bar is unknown on the board (see {@link buildSelectorContext}); the
 * server stays authoritative.
 */
export function buildCardTargetContext(
  view: GameBoardView,
  ctx: CardBehaviorSelectorContext,
  serverNowMs: number,
): CardTargetContext {
  const barCoords = new Map<string, LatLng>();
  for (const [barKey, ref] of ctx.bars) {
    if (ref.coords !== null) {
      barCoords.set(barKey, ref.coords);
    }
  }

  const claimState: Record<string, string[]> = {};
  for (const claim of ctx.activeClaims) {
    (claimState[claim.barKey] ??= []).push(claim.teamId);
  }

  const startRef: ResolvedBarRef = { barKey: "", kind: "start", coords: null };
  const previousBars = new Map<string, ResolvedBarRef>();
  for (const team of view.teams) {
    previousBars.set(team.id, ctx.previousBarByTeam.get(team.id) ?? startRef);
  }

  const restrictions = new Map<string, NextClaimRule[]>();
  for (const effect of Object.values(view.cardBehavior.effects)) {
    if (
      effect.kind !== "next_claim_restriction" ||
      effect.targetTeamId === null ||
      !isEffectActive(effect, serverNowMs)
    ) {
      continue;
    }
    const rule = effect.params.rule;
    if (rule === "pioneer" || rule === "scenic") {
      const list = restrictions.get(effect.targetTeamId) ?? [];
      list.push(rule);
      restrictions.set(effect.targetTeamId, list);
    }
  }

  return {
    finishBarKey: null,
    barCoords,
    claimState,
    teamIds: view.teams.map((team) => team.id),
    previousBars,
    restrictions,
  };
}

// ---------------------------------------------------------------------------
// Toast composition.
// ---------------------------------------------------------------------------

/** The id of the Fairest prompt toast for an offer. */
export function fairestPromptToastId(offerId: string): string {
  return `fairest_prompt:${offerId}`;
}

/** Inputs to {@link composeBoardToasts}. */
export interface ComposeBoardToastsInput {
  readonly view: GameBoardView;
  /** The viewing team, or null for a viewer with no team (host / spectator). */
  readonly viewerTeamId: string | null;
  /** The Boundary_Toasts from `deriveBoundaryToasts` (already filtered). */
  readonly boundaryToasts: readonly Toast[];
  /** The per-game dismissal record. */
  readonly dismissal: ToastDismissalRecord;
  readonly timeZone?: string;
}

function teamName(view: GameBoardView, teamId: string): string {
  return view.teams.find((team) => team.id === teamId)?.name ?? teamId;
}

/**
 * The toast id of the descriptor whose toast should carry a challenge's actions:
 * the mirror toast for a Mirrored_Challenge, else the source play's toast.
 */
function hostToastIdForChallenge(
  view: GameBoardView,
  challengeId: string,
): string | null {
  const challenge = view.cardBehavior.challenges[challengeId];
  if (challenge === undefined) {
    return null;
  }
  const events = view.cardBehavior.toastEvents;
  if (challenge.mirroredFromChallengeId !== null) {
    const mirror = events.find(
      (event) =>
        event.kind === "fairest_decided" &&
        view.cardBehavior.offers[event.subjectId]?.mirroredChallengeId ===
          challengeId,
    );
    if (mirror !== undefined) {
      return mirror.id;
    }
  }
  const play = events.find(
    (event) =>
      event.kind === "play" && event.subjectId === challenge.sourcePlayId,
  );
  return play?.id ?? null;
}

/** A standalone action toast for a challenge with no folded toast to host it. */
function fallbackChallengeToast(
  view: GameBoardView,
  challengeId: string,
  actions: readonly ToastAction[],
): Toast | null {
  const challenge = view.cardBehavior.challenges[challengeId];
  if (challenge === undefined) {
    return null;
  }
  const text = getCardText(challenge.slug);
  const values = {
    Caster: teamName(view, challenge.casterTeamId),
    Target: teamName(view, challenge.targetTeamId),
    CARD: getCardMetadata(challenge.slug).name.toUpperCase(),
  };
  return {
    id: `action:challenge:${challengeId}`,
    kind: "target",
    seq: view.cardBehavior.plays[challenge.sourcePlayId]?.seq ?? 0,
    headline: renderTemplate("{Caster} has played {CARD} on you!", values),
    body:
      text.targetToastBody === null
        ? null
        : renderTemplate(text.targetToastBody, values),
    dropdown: null,
    actions,
    dismissable: false,
  };
}

/** The Fairest prompt toast offering Play / Decline for one offer. */
function fairestPromptToast(
  view: GameBoardView,
  offer: FairestOfferRecord,
  actions: readonly ToastAction[],
): Toast {
  const template =
    getCardText("fairest-of-them-all").toasts?.fairestPrompt ??
    "Play FAIREST OF THEM ALL to make {Caster} complete this challenge too?";
  return {
    id: fairestPromptToastId(offer.offerId),
    kind: "fairest_prompt",
    seq: view.cardBehavior.plays[offer.sourcePlayId]?.seq ?? 0,
    headline: renderTemplate(template, {
      Caster: teamName(view, offer.originalCasterTeamId),
    }),
    body: null,
    dropdown: null,
    actions,
    dismissable: false,
  };
}

/**
 * The toast stack for one viewer (design.md section 13):
 *
 * 1. `deriveToasts` renders every folded toast descriptor for the viewer.
 * 2. `selectPendingActions` supplies the actions the viewer's team owes. Mark
 *    complete / We failed attach to the toast of the challenge's source play (or
 *    the mirror toast for a Mirrored_Challenge), which then stops being
 *    dismissable (3.8); a challenge with no folded toast gets a standalone
 *    action toast. Fairest Play / Decline become their own prompt toast.
 * 3. Dismissable toasts are dropped when dismissed on this device or at / below
 *    the dismissal `floorSeq` (no late-join replay). Action toasts are always
 *    kept, so a reload or reconnect rebuilds them (3.9).
 * 4. Boundary_Toasts merge in by id through a `Map`, so the same toast is never
 *    shown twice.
 *
 * Event toasts are ordered by seq, then id, followed by the Boundary_Toasts in
 * their given order.
 */
export function composeBoardToasts(input: ComposeBoardToastsInput): Toast[] {
  const { view, viewerTeamId, dismissal } = input;
  const byId = new Map<string, Toast>();
  for (const toast of deriveToasts(view, viewerTeamId, {
    timeZone: input.timeZone,
  })) {
    byId.set(toast.id, toast);
  }

  if (viewerTeamId !== null) {
    const challengeActions = new Map<string, ToastAction[]>();
    const offerActions = new Map<string, ToastAction[]>();
    for (const action of selectPendingActions(view, viewerTeamId)) {
      if (action.kind === "mark_complete" || action.kind === "we_failed") {
        const list = challengeActions.get(action.challengeId) ?? [];
        list.push(action);
        challengeActions.set(action.challengeId, list);
      } else {
        const list = offerActions.get(action.offerId) ?? [];
        list.push(action);
        offerActions.set(action.offerId, list);
      }
    }

    for (const [challengeId, actions] of challengeActions) {
      const hostId = hostToastIdForChallenge(view, challengeId);
      const host = hostId === null ? undefined : byId.get(hostId);
      if (host !== undefined) {
        byId.set(host.id, {
          ...host,
          actions: [...host.actions, ...actions],
          dismissable: false,
        });
        continue;
      }
      const fallback = fallbackChallengeToast(view, challengeId, actions);
      if (fallback !== null) {
        byId.set(fallback.id, fallback);
      }
    }

    for (const [offerId, actions] of offerActions) {
      const offer = view.cardBehavior.offers[offerId];
      if (offer !== undefined) {
        const prompt = fairestPromptToast(view, offer, actions);
        byId.set(prompt.id, prompt);
      }
    }
  }

  const dismissed = new Set(dismissal.dismissed);
  const eventToasts = [...byId.values()]
    .filter(
      (toast) =>
        !toast.dismissable ||
        (!dismissed.has(toast.id) && toast.seq > dismissal.floorSeq),
    )
    .sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

  const merged = new Map<string, Toast>();
  for (const toast of eventToasts) {
    merged.set(toast.id, toast);
  }
  for (const toast of input.boundaryToasts) {
    if (!merged.has(toast.id) && !dismissed.has(toast.id)) {
      merged.set(toast.id, toast);
    }
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Dismissal storage.
// ---------------------------------------------------------------------------

/** The localStorage key for a game's dismissal record. */
export function dismissalStorageKey(gameId: string): string {
  return `bbb:toasts:${gameId}`;
}

/** Parse a stored dismissal record; null when absent or malformed. */
export function parseDismissalRecord(
  raw: string | null,
): ToastDismissalRecord | null {
  if (raw === null) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const { floorSeq, dismissed } = value as Record<string, unknown>;
    if (
      typeof floorSeq !== "number" ||
      !Number.isFinite(floorSeq) ||
      !Array.isArray(dismissed) ||
      !dismissed.every((id) => typeof id === "string")
    ) {
      return null;
    }
    return { floorSeq, dismissed: dismissed as string[] };
  } catch {
    return null;
  }
}

/** Read a game's dismissal record from localStorage (never throws). */
export function readDismissalRecord(
  gameId: string,
): ToastDismissalRecord | null {
  try {
    return parseDismissalRecord(
      globalThis.localStorage?.getItem(dismissalStorageKey(gameId)) ?? null,
    );
  } catch {
    return null;
  }
}

/** Persist a game's dismissal record to localStorage (never throws). */
export function writeDismissalRecord(
  gameId: string,
  record: ToastDismissalRecord,
): void {
  try {
    globalThis.localStorage?.setItem(
      dismissalStorageKey(gameId),
      JSON.stringify(record),
    );
  } catch {
    // Storage unavailable (private mode / SSR): dismissal lasts for the session.
  }
}

/** Add a dismissed toast id to a record (idempotent). */
export function withDismissed(
  record: ToastDismissalRecord,
  toastId: string,
): ToastDismissalRecord {
  if (record.dismissed.includes(toastId)) {
    return record;
  }
  return {
    floorSeq: record.floorSeq,
    dismissed: [...record.dismissed, toastId],
  };
}
