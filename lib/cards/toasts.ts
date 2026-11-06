/**
 * Per-viewer toast copy for the card-behavior feature (`lib/cards/toasts.ts`).
 *
 * Pure and framework-free (design.md section 13). The Board_Projection folds
 * each toast-producing card-behavior event into an audience-agnostic
 * {@link ToastEvent} descriptor (`lib/gameboard/events.ts`); this module turns
 * those descriptors, plus the embedded records they point at, into the finished
 * {@link Toast} copy a single viewer team should see. The projection never knows
 * who is looking; the routing lives here.
 *
 * Responsibilities:
 *
 *   - {@link audienceRole}: the viewer's role (caster / target / others) for a
 *     play, used to pick which template renders.
 *   - {@link deriveToasts}: the seq-ordered list of {@link Toast}s for one viewer,
 *     following the design's routing rules (team plays, bar / self / no-target
 *     plays with overrides, Patient Investor payout, Fairest mirror and
 *     mirror_others, host override, and the Voted Off removal body). Effect
 *     transition events produce no toast here; their Boundary_Toasts come from
 *     `deriveBoundaryToasts` (task 9.7).
 *   - {@link selectPendingActions}: the action buttons a team currently owes
 *     (Mark complete / We failed / Fairest Play / Decline), derived purely from
 *     the folded challenge and offer state so a reload or reconnect rebuilds
 *     them (3.9).
 *
 * Templates are filled with each play's recorded values (colors, duration,
 * cuisine, caster / target names, bar name, and timer clock times) via
 * `renderTemplate` from `./templates`.
 */

import type { GameBoardView, ToastEvent } from "@/lib/gameboard/events";
import type { ChallengeRecord, FairestOfferRecord } from "./behaviorState";
import type { PlayView } from "@/lib/gameboard/events";
import type { CastingParams } from "./inputs";
import type { CardSlug } from "./catalog";
import { getCardMetadata, getCardText } from "./catalog";
import type { TemplateValues } from "./templates";
import { renderTemplate, formatDuration, formatClockTime } from "./templates";
import { CANDIDATE_BARS } from "@/lib/map/bars";

// ---------------------------------------------------------------------------
// Public shapes (design.md section 13).
// ---------------------------------------------------------------------------

/**
 * The kind of toast, which drives both its copy and how the board renders it.
 * `fairest_prompt` and the challenge-action kinds surface the pending actions
 * from {@link selectPendingActions}; everything else is folded from a
 * {@link ToastEvent}.
 */
export type ToastKind =
  | "target"
  | "caster"
  | "others"
  | "announcement"
  | "start"
  | "end"
  | "payout"
  | "mirror"
  | "mirror_others"
  | "fairest_prompt"
  | "host_override"
  | "voted_off_target";

/**
 * An action a toast offers the viewing team. The board posts the matching route
 * when the button is pressed; the id ties the action to its durable record.
 */
export type ToastAction =
  | { readonly kind: "mark_complete"; readonly challengeId: string }
  | { readonly kind: "we_failed"; readonly challengeId: string }
  | { readonly kind: "fairest_play"; readonly offerId: string }
  | { readonly kind: "fairest_decline"; readonly offerId: string };

/**
 * One rendered toast for a single viewer. `id` is the stable `${seq}:${kind}:
 * ${subjectId}` identity of the source descriptor so the board can keep a `Map`
 * keyed by it and never show a duplicate. `dismissable` is false while the toast
 * carries a pending action (3.8).
 */
export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly seq: number;
  readonly headline: string;
  readonly body: string | null;
  /** The others' toast Effect text, shown in an expandable dropdown. */
  readonly dropdown: string | null;
  readonly actions: readonly ToastAction[];
  readonly dismissable: boolean;
}

/** Headline shown when a claim is blocked (3.10, 4.5). */
export const CLAIM_BLOCKED_HEADLINE = "Your team can't claim this bar yet.";

/**
 * The per-game dismissal record persisted in localStorage and shared with
 * `deriveBoundaryToasts` (9.7). `floorSeq` is the snapshot watermark at the
 * device's first load of the game, so historical informational toasts are not
 * replayed on a late join; `dismissed` is the set of toast ids the viewer has
 * dismissed on this device.
 */
export interface ToastDismissalRecord {
  readonly floorSeq: number;
  readonly dismissed: readonly string[];
}

// ---------------------------------------------------------------------------
// Standard templates (docs/card-text-oracle.md, "Standard toast templates").
// ---------------------------------------------------------------------------

const TEAM_TARGET_HEADLINE = "{Caster} has played {CARD} on you!";
const TEAM_OTHERS_HEADLINE = "{Caster} played {CARD} on {Target}!";
const TEAM_CASTER = "You played {CARD} on {Target}.";
const BAR_OTHERS_HEADLINE = "{Caster} played {CARD} on {Bar}!";
const BAR_CASTER = "You played {CARD} on {Bar}.";
const NONE_OTHERS_HEADLINE = "{Caster} played {CARD}!";
const NONE_CASTER = "You played {CARD}.";

const HOST_CLEARED = "The host cleared {CARD} for {Target}.";
const HOST_REOPENED = "The host reopened {CARD} for {Target}.";
const HOST_ENDED = "The host ended {CARD} early.";

// ---------------------------------------------------------------------------
// Audience routing.
// ---------------------------------------------------------------------------

/**
 * The viewer's role in a play: `caster` when the viewer is the casting team,
 * `target` when the viewer is the team the play targeted, else `others`. A
 * viewer with no team (a spectator / the host) is always `others`.
 */
export function audienceRole(
  viewerTeamId: string | null,
  casterTeamId: string,
  targetTeamId: string | null,
): "caster" | "target" | "others" {
  if (viewerTeamId === null) {
    return "others";
  }
  if (viewerTeamId === casterTeamId) {
    return "caster";
  }
  if (targetTeamId !== null && viewerTeamId === targetTeamId) {
    return "target";
  }
  return "others";
}

// ---------------------------------------------------------------------------
// deriveToasts.
// ---------------------------------------------------------------------------

/**
 * Render the seq-ordered {@link Toast}s one viewer should see from the view's
 * folded {@link ToastEvent} descriptors (design.md section 13). The viewer's
 * team id selects the audience-appropriate copy; `opts.timeZone` localizes any
 * clock times. Effect transition descriptors never appear in the fold, so this
 * never produces a Boundary_Toast.
 */
export function deriveToasts(
  view: GameBoardView,
  viewerTeamId: string | null,
  opts: { timeZone?: string } = {},
): Toast[] {
  const toasts: Toast[] = [];
  for (const event of view.cardBehavior.toastEvents) {
    const toast = deriveToastForEvent(view, viewerTeamId, event, opts.timeZone);
    if (toast !== null) {
      toasts.push(toast);
    }
  }
  return toasts;
}

function deriveToastForEvent(
  view: GameBoardView,
  viewerTeamId: string | null,
  event: ToastEvent,
  timeZone: string | undefined,
): Toast | null {
  switch (event.kind) {
    case "play":
      return derivePlayToast(view, viewerTeamId, event, timeZone);
    case "fairest_decided":
      return deriveMirrorToast(view, viewerTeamId, event, timeZone);
    case "payout":
      return derivePayoutToast(view, event);
    case "host_override":
      return deriveHostOverrideToast(view, event);
    case "challenge_resolved":
    case "bonus_claimed":
      // Not routed to a toast here (design.md section 13 routing rules).
      return null;
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Play toasts (team / bar / self / none).
// ---------------------------------------------------------------------------

function derivePlayToast(
  view: GameBoardView,
  viewerTeamId: string | null,
  event: ToastEvent,
  timeZone: string | undefined,
): Toast | null {
  const play = view.cardBehavior.plays[event.subjectId];
  if (play === undefined) {
    return null;
  }
  const values = playTemplateValues(view, play, timeZone);
  const slug = play.slug;
  const meta = getCardMetadata(slug);
  const text = getCardText(slug);
  const role = audienceRole(viewerTeamId, play.casterTeamId, play.targetTeamId);

  if (role === "caster") {
    return makeToast(event, "caster", {
      headline: renderTemplate(casterTemplate(meta.targetMode), values),
    });
  }

  const targetsTeam = play.targetTeamId !== null;
  if (role === "target" && targetsTeam) {
    // Voted Off the Island targets get the removal body, not a gate body (18.8).
    return makeToast(
      event,
      slug === "voted-off-the-island" ? "voted_off_target" : "target",
      {
        headline: renderTemplate(TEAM_TARGET_HEADLINE, values),
        body:
          text.targetToastBody === null
            ? null
            : renderTemplate(text.targetToastBody, values),
      },
    );
  }

  // Everyone else: the others' toast. A defined announcement / othersBody
  // override replaces the standard others' headline for the non-casting teams.
  const override = text.toasts?.announcement;
  const othersBody = text.toasts?.othersBody;
  const headline =
    override !== undefined
      ? renderTemplate(override, values)
      : renderTemplate(othersHeadlineTemplate(meta.targetMode), values);
  return makeToast(event, override !== undefined ? "announcement" : "others", {
    headline,
    body: othersBody === undefined ? null : renderTemplate(othersBody, values),
    // The Effect text goes in the expandable dropdown (3.3); an override
    // headline already carries the salient detail, so it has no dropdown.
    dropdown:
      override !== undefined ? null : renderTemplate(text.effect, values),
    dismissable: true,
  });
}

function casterTemplate(
  targetMode: ReturnType<typeof getCardMetadata>["targetMode"],
): string {
  switch (targetMode) {
    case "team":
    case "team_and_bar":
      return TEAM_CASTER;
    case "bar":
      return BAR_CASTER;
    default:
      return NONE_CASTER;
  }
}

function othersHeadlineTemplate(
  targetMode: ReturnType<typeof getCardMetadata>["targetMode"],
): string {
  switch (targetMode) {
    case "team":
    case "team_and_bar":
      return TEAM_OTHERS_HEADLINE;
    case "bar":
      return BAR_OTHERS_HEADLINE;
    default:
      return NONE_OTHERS_HEADLINE;
  }
}

// ---------------------------------------------------------------------------
// Fairest mirror toasts.
// ---------------------------------------------------------------------------

function deriveMirrorToast(
  view: GameBoardView,
  viewerTeamId: string | null,
  event: ToastEvent,
  timeZone: string | undefined,
): Toast | null {
  const offer = view.cardBehavior.offers[event.subjectId];
  if (offer === undefined || offer.status !== "played") {
    // Only a played Fairest produces a mirror toast; a declined / void offer
    // routes nothing (the holder has already seen its own challenge).
    return null;
  }
  const fairestText = getCardText("fairest-of-them-all");
  const mirrorHeadline = fairestText.toasts?.mirrorHeadline;
  const mirrorOthersHeadline = fairestText.toasts?.mirrorOthersHeadline;
  if (mirrorHeadline === undefined || mirrorOthersHeadline === undefined) {
    return null;
  }

  const values = mirrorTemplateValues(view, offer, timeZone);

  // The holder (original target) gets no mirror toast; it already sees its own
  // challenge. The original caster must now also complete the challenge.
  if (viewerTeamId !== null && viewerTeamId === offer.holderTeamId) {
    return null;
  }

  if (viewerTeamId !== null && viewerTeamId === offer.originalCasterTeamId) {
    const originalText = getCardText(offer.slug);
    return makeToast(event, "mirror", {
      headline: renderTemplate(mirrorHeadline, values),
      body:
        originalText.targetToastBody === null
          ? null
          : renderTemplate(originalText.targetToastBody, values),
    });
  }

  return makeToast(event, "mirror_others", {
    headline: renderTemplate(mirrorOthersHeadline, values),
    dismissable: true,
  });
}

// ---------------------------------------------------------------------------
// Patient Investor payout toast.
// ---------------------------------------------------------------------------

function derivePayoutToast(
  view: GameBoardView,
  event: ToastEvent,
): Toast | null {
  const entry = view.scoreEntries.find((e) => e.entryId === event.subjectId);
  if (entry === undefined) {
    return null;
  }
  const payout = getCardText("patient-investor").toasts?.payout;
  if (payout === undefined) {
    return null;
  }
  const values: TemplateValues = { Caster: teamName(view, entry.teamId) };
  return makeToast(event, "payout", {
    headline: renderTemplate(payout, values),
    dismissable: true,
  });
}

// ---------------------------------------------------------------------------
// Host override toast.
// ---------------------------------------------------------------------------

function deriveHostOverrideToast(
  view: GameBoardView,
  event: ToastEvent,
): Toast | null {
  const challenge = view.cardBehavior.challenges[event.subjectId];
  if (challenge !== undefined) {
    const values: TemplateValues = {
      CARD: cardName(challenge.slug),
      Target: teamName(view, challenge.targetTeamId),
    };
    // A cleared challenge reads "cleared"; a reset one is back to `open`.
    const template =
      challenge.status === "cleared_by_host" ? HOST_CLEARED : HOST_REOPENED;
    return makeToast(event, "host_override", {
      headline: renderTemplate(template, values),
      dismissable: true,
    });
  }

  const effect = view.cardBehavior.effects[event.subjectId];
  if (effect !== undefined) {
    const values: TemplateValues = { CARD: cardName(effect.slug) };
    return makeToast(event, "host_override", {
      headline: renderTemplate(HOST_ENDED, values),
      dismissable: true,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pending actions (design.md section 13; Property 5).
// ---------------------------------------------------------------------------

/**
 * The action buttons a team currently owes, derived purely from the folded
 * challenge and offer state so a reload or reconnect rebuilds them (3.9):
 *
 *   - Mark complete for each open, non-UIOLI challenge targeting the team that
 *     has no live Fairest offer.
 *   - We failed additionally for Everyone's a Critic.
 *   - Play and Decline for each pending offer whose holder is the team.
 *
 * It contains nothing for Pioneer, Scenic Route, or Voted Off notices (those
 * challenges / restrictions never produce a gate action). Use It or Lose It's
 * per-card discard action lives in the hand (8.2), not here.
 */
export function selectPendingActions(
  view: GameBoardView,
  teamId: string,
): ToastAction[] {
  const actions: ToastAction[] = [];

  // Pending Fairest offers held by this team: Play and Decline.
  for (const offer of liveOffersSorted(view.cardBehavior.offers)) {
    if (offer.holderTeamId === teamId) {
      actions.push({ kind: "fairest_play", offerId: offer.offerId });
      actions.push({ kind: "fairest_decline", offerId: offer.offerId });
    }
  }

  // Open challenges targeting this team: Mark complete (+ We failed for Critic),
  // suppressed while a live Fairest offer is pending for that challenge.
  for (const challenge of openChallengesSorted(view.cardBehavior.challenges)) {
    if (challenge.targetTeamId !== teamId) {
      continue;
    }
    if (!isGatedActionChallenge(challenge.slug)) {
      continue;
    }
    if (hasLiveFairestOffer(view, challenge.challengeId)) {
      continue;
    }
    actions.push({ kind: "mark_complete", challengeId: challenge.challengeId });
    if (challenge.slug === "everyones-a-critic") {
      actions.push({ kind: "we_failed", challengeId: challenge.challengeId });
    }
  }

  return actions;
}

/**
 * A challenge whose target owes a Mark complete action: an open, gated team
 * challenge. Pioneer, Scenic Route, and Voted Off (completionRequired false) are
 * excluded, and Use It or Lose It's resolution lives in the hand, so it has no
 * Mark complete.
 */
function isGatedActionChallenge(slug: CardSlug): boolean {
  if (slug === "use-it-or-lose-it") {
    return false;
  }
  const meta = getCardMetadata(slug);
  return meta.completionRequired && meta.targetMode === "team";
}

/** A pending offer tied to `challengeId` whose holder still holds Fairest. */
function hasLiveFairestOffer(
  view: GameBoardView,
  challengeId: string,
): boolean {
  return Object.values(view.cardBehavior.offers).some(
    (offer) => offer.status === "pending" && offer.challengeId === challengeId,
  );
}

function liveOffersSorted(
  offers: Readonly<Record<string, FairestOfferRecord>>,
): FairestOfferRecord[] {
  return Object.values(offers)
    .filter((offer) => offer.status === "pending")
    .sort((a, b) => a.offerId.localeCompare(b.offerId));
}

function openChallengesSorted(
  challenges: Readonly<Record<string, ChallengeRecord>>,
): ChallengeRecord[] {
  return Object.values(challenges)
    .filter((challenge) => challenge.status === "open")
    .sort((a, b) => a.challengeId.localeCompare(b.challengeId));
}

// ---------------------------------------------------------------------------
// Template value helpers.
// ---------------------------------------------------------------------------

function playTemplateValues(
  view: GameBoardView,
  play: PlayView,
  timeZone: string | undefined,
): TemplateValues {
  const values: TemplateValues = {
    Caster: teamName(view, play.casterTeamId),
    CARD: cardName(play.slug),
  };
  if (play.targetTeamId !== null) {
    values.Target = teamName(view, play.targetTeamId);
  }
  if (play.barKey !== null) {
    values.Bar = barName(play.barKey);
  } else if (play.returnBarKey !== null) {
    // Spin Cycle has no target bar; {Bar} is the target team's return bar (its
    // most recent claim, or the start bar), resolved by the server at play time.
    values.Bar = barName(play.returnBarKey);
  }
  mergeParamValues(values, play.params);
  mergeEffectClockTimes(values, view, play.playId, timeZone);
  return values;
}

function mirrorTemplateValues(
  view: GameBoardView,
  offer: FairestOfferRecord,
  timeZone: string | undefined,
): TemplateValues {
  const values: TemplateValues = {
    Caster: teamName(view, offer.originalCasterTeamId),
    Target: teamName(view, offer.holderTeamId),
    CARD: cardName(offer.slug),
  };
  // The mirror body is the original card's target toast with the same entered
  // values, so fill from the source play when it is in the fold.
  const play = view.cardBehavior.plays[offer.sourcePlayId];
  if (play !== undefined) {
    mergeParamValues(values, play.params);
    if (play.barKey !== null) {
      values.Bar = barName(play.barKey);
    } else if (play.returnBarKey !== null) {
      // Spin Cycle mirror: name the return bar carried on the source play so the
      // body's {Bar} is filled (the original target's return bar).
      values.Bar = barName(play.returnBarKey);
    }
    mergeEffectClockTimes(values, view, play.playId, timeZone);
  }
  return values;
}

/** Fill the caster-entered values (colors, duration, cuisine) into `values`. */
function mergeParamValues(values: TemplateValues, params: CastingParams): void {
  switch (params.kind) {
    case "colors":
      values.color1 = params.colors[0];
      values.color2 = params.colors[1];
      values.color3 = params.colors[2];
      return;
    case "duration_seconds":
      values.duration = formatDuration(params.seconds);
      return;
    case "cuisine":
      values.cuisine = params.cuisine;
      return;
    case "none":
      return;
    default: {
      const _exhaustive: never = params;
      return _exhaustive;
    }
  }
}

/**
 * Fill `{startTime}` / `{endTime}` from the timed effect the play created, as
 * Clock_Times in the viewer's time zone (3.6). A play creates at most one timed
 * window, so the first effect whose `sourcePlayId` matches supplies the bounds.
 */
function mergeEffectClockTimes(
  values: TemplateValues,
  view: GameBoardView,
  playId: string,
  timeZone: string | undefined,
): void {
  for (const effect of Object.values(view.cardBehavior.effects)) {
    if (effect.sourcePlayId !== playId) {
      continue;
    }
    values.startTime = formatClockTime(effect.startsAt, timeZone);
    if (effect.endsAt !== null) {
      values.endTime = formatClockTime(effect.endsAt, timeZone);
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Name lookups.
// ---------------------------------------------------------------------------

const BAR_NAME_BY_KEY: ReadonlyMap<string, string> = new Map(
  CANDIDATE_BARS.map((bar) => [bar.id, bar.name] as const),
);

/** The human-readable bar name for a bar key, falling back to the key itself. */
function barName(barKey: string): string {
  return BAR_NAME_BY_KEY.get(barKey) ?? barKey;
}

/** The display name of a team, falling back to the id when it is not folded. */
function teamName(view: GameBoardView, teamId: string): string {
  const team = view.teams.find((t) => t.id === teamId);
  return team?.name ?? teamId;
}

/** The uppercase card name used in copy (`{CARD}`). */
function cardName(slug: CardSlug): string {
  return getCardMetadata(slug).name.toUpperCase();
}

// ---------------------------------------------------------------------------
// Toast construction.
// ---------------------------------------------------------------------------

function makeToast(
  event: ToastEvent,
  kind: ToastKind,
  parts: {
    readonly headline: string;
    readonly body?: string | null;
    readonly dropdown?: string | null;
    readonly actions?: readonly ToastAction[];
    readonly dismissable?: boolean;
  },
): Toast {
  const actions = parts.actions ?? [];
  return {
    id: event.id,
    kind,
    seq: event.seq,
    headline: parts.headline,
    body: parts.body ?? null,
    dropdown: parts.dropdown ?? null,
    actions,
    // A toast carrying a pending action stays visible until the action resolves
    // (3.8); everything else is dismissable unless explicitly marked otherwise.
    dismissable: parts.dismissable ?? actions.length === 0,
  };
}
