import type { CardSlug } from "./catalog";

// ---------------------------------------------------------------------------
// Finalized player-facing card text (card-behavior spec, Task 1.1)
// ---------------------------------------------------------------------------

/**
 * The player-facing text and toast copy for every Brawl Deck card. The strings
 * below are copied verbatim from `docs/card-text-oracle.md` (the wording source
 * of truth), with line wraps joined by single spaces. The Challenge_Gate rule
 * ("you can't claim a bar until you do") is deliberately omitted from all copy,
 * since the app enforces it.
 *
 * `{Caster}` / `{Target}` are team names, `{CARD}` is the card name in caps,
 * `{Bar}` is a bar name, and `{color1}` / `{color2}` / `{color3}` / `{duration}`
 * / `{cuisine}` / `{startTime}` / `{endTime}` are values the caster entered or a
 * timer boundary. These are the only legal {@link TemplatePlaceholder} tokens.
 */

/** The placeholders that may appear in any card-text or toast string. */
export type TemplatePlaceholder =
  | "Caster"
  | "Target"
  | "CARD"
  | "Bar"
  | "color1"
  | "color2"
  | "color3"
  | "duration"
  | "cuisine"
  | "startTime"
  | "endTime";

/**
 * Per-card overrides for the standard toast templates. Only cards whose toasts
 * differ from the defaults carry any of these; everything omitted falls back to
 * the standard headline/body for the card's target mode.
 */
export interface CardToastOverrides {
  /** Replaces the others' headline for non-casters (all-teams announcement toast). */
  readonly announcement?: string;
  /** Crop Dusting others' body. */
  readonly othersBody?: string;
  /** Cancel Culture start toast. */
  readonly start?: string;
  /** Timed end toast. */
  readonly end?: string;
  /** Patient Investor payout toast. */
  readonly payout?: string;
  /** Fairest mirror toast to the original caster. */
  readonly mirrorHeadline?: string;
  /** Fairest mirror others' headline. */
  readonly mirrorOthersHeadline?: string;
  /** Fairest prompt shown inside the holder's target toast. */
  readonly fairestPrompt?: string;
  /** Everyone's a Critic target-toast action labels. */
  readonly actions?: {
    readonly complete: string;
    readonly failed?: string;
  };
}

/**
 * The player-facing text for a card, read top to bottom in the hand-inspection
 * UI: `requires` (only when the card has a casting condition), then `effect`,
 * then the `targetNote`. `targetToastBody` is the second-person body the
 * targeted team sees; it is `null` for cards with no team target. `toasts`
 * carries per-card overrides of the standard toast templates.
 */
export interface CardText {
  readonly requires: string | null;
  readonly effect: string;
  readonly targetNote: string;
  readonly targetToastBody: string | null;
  readonly toasts?: CardToastOverrides;
}

const CARD_TEXT_ENTRIES: Readonly<Record<CardSlug, CardText>> = {
  "go-piss-girl": {
    requires: null,
    effect:
      "A member of the target team must enter a publicly accessible restroom that is not inside a bar.",
    targetNote: "An opposing team.",
    targetToastBody:
      "At least one member of your team must enter a publicly accessible restroom that is not inside a bar.",
  },
  "crop-dusting": {
    requires: "Your team must be inside the bar you target.",
    effect: "No other team may enter or claim this bar for 15 minutes.",
    targetNote: "The bar you're in. Can't be the finish bar.",
    targetToastBody: null,
    toasts: {
      othersBody: "No team may enter or claim {Bar} until {endTime}.",
      end: "CROP DUSTING has ended. {Bar} can be claimed again.",
    },
  },
  moneybags: {
    requires: null,
    effect:
      "The target team must find a product with a visible price tag over $150 inside a retail store and photograph the price tag.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must find a product with a visible price tag over $150 inside a retail store and photograph the price tag.",
  },
  "use-it-or-lose-it": {
    requires: null,
    effect:
      "The target team must immediately play every card in their hand. Any card whose requirements they can't meet right now is discarded with no effect.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must immediately play every card in your hand. Any card whose requirements you can't meet right now is discarded with no effect.",
  },
  wired: {
    requires: null,
    effect:
      "The target team must order a shot of espresso from a place that is not a bar.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must order a shot of espresso from a place that is not a bar.",
  },
  "art-school-dropout": {
    requires:
      "Take a photo of a mural, graffiti, or art installation containing three distinct ROYGBIV colors, then enter those three colors.",
    effect:
      "The target team must photograph a different mural, graffiti, or art installation containing the same three colors.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must photograph a mural, graffiti, or art installation containing {color1}, {color2}, and {color3}. It must be a different piece than {Caster}'s.",
  },
  "broad-shoulders": {
    requires: null,
    effect:
      "The target team must take a photo with at least one team member next to an official ATL Tiny Door.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must take a photo with at least one team member next to an official ATL Tiny Door.",
  },
  "bird-guide": {
    requires:
      "Film a continuous video of a single bird staying in frame (up to 5 minutes), then enter how long it lasted.",
    effect:
      "The target team must film a continuous video of a different bird staying in frame for at least as long.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must film a continuous video of a bird staying in frame for at least {duration}. It must be a different bird than {Caster}'s.",
  },
  "interested-buyer": {
    requires: null,
    effect:
      "The target team must get a souvenir or brochure from an apartment leasing office. If most leasing offices are closed today, a photo in front of one counts instead.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must get a souvenir or brochure from an apartment leasing office. If most leasing offices are closed today, a photo in front of one counts instead.",
  },
  "different-tastes": {
    requires: "Take a picture next to a restaurant, then enter its cuisine.",
    effect:
      "The target team must take a picture next to a restaurant whose cuisine is from the same continent.",
    targetNote: "An opposing team.",
    targetToastBody:
      "{Caster} found a {cuisine} restaurant. Your team must take a picture next to a restaurant whose cuisine is from the same continent.",
  },
  "everyones-a-critic": {
    requires: null,
    effect:
      "The target team must take a picture on the premises of a place with at least 4.5 stars on Google. They can't use the internet for research until they make an attempt. If they fail, they can't claim a bar for 15 minutes.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must take a picture on the premises of a place with at least 4.5 stars on Google. You can't use the internet for research until you make an attempt. If you fail, you can't claim a bar for 15 minutes.",
    toasts: {
      actions: {
        complete: "Mark complete",
        failed: "We failed (starts the 15-minute block)",
      },
    },
  },
  "fairest-of-them-all": {
    requires:
      "Play this immediately after your team is targeted by a challenge card.",
    effect: "The team that challenged you must also complete that challenge.",
    targetNote: "The team that just challenged you.",
    targetToastBody: null,
    toasts: {
      fairestPrompt:
        "Play FAIREST OF THEM ALL to make {Caster} complete this challenge too?",
      mirrorHeadline:
        "{Target} played FAIREST OF THEM ALL! Your team must also complete {CARD}.",
      mirrorOthersHeadline:
        "{Target} turned {CARD} back on {Caster} with FAIREST OF THEM ALL!",
    },
  },
  pioneer: {
    requires: null,
    effect:
      "The target team's next claimed bar must be one no other team has claimed, and it can't be the finish bar.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your next claimed bar must be one no other team has claimed, and it can't be the finish bar.",
  },
  "cancel-culture": {
    requires: null,
    effect:
      "Starting 15 minutes from now, no bar within 0.25 miles of the target bar can be claimed for 15 minutes.",
    targetNote:
      "A bar not within 0.25 miles of the finish bar. All teams are told which bar.",
    targetToastBody: null,
    toasts: {
      announcement:
        "{Caster} played CANCEL CULTURE on {Bar}! Starting at {startTime}, no bar within 0.25 miles of {Bar} can be claimed for 15 minutes.",
      start:
        "CANCEL CULTURE is now in effect. No bar within 0.25 miles of {Bar} can be claimed until {endTime}.",
      end: "CANCEL CULTURE has ended. Bars near {Bar} can be claimed again.",
    },
  },
  "spin-cycle": {
    requires: null,
    effect:
      "The target team must immediately return to the entrance of the bar they most recently claimed.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must immediately return to the entrance of {Bar}.",
  },
  "dirty-bird": {
    requires: null,
    effect:
      "The target team must take a photo with someone outside their team who is wearing Atlanta sports merchandise.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your team must take a photo with someone outside your team who is wearing Atlanta sports merchandise.",
  },
  "scenic-route": {
    requires: null,
    effect:
      "The target team's next claimed bar must be farther from the finish bar than the last bar they claimed.",
    targetNote: "An opposing team.",
    targetToastBody:
      "Your next claimed bar must be farther from the finish bar than the last bar you claimed.",
  },
  insurance: {
    requires: null,
    effect:
      "The points your team earns from its next claimed bar can't be reduced by teams that claim it later. Other teams share normally.",
    targetNote: "Your own team.",
    targetToastBody: null,
  },
  "happy-hour": {
    requires: null,
    effect:
      "For the next hour, each team's first drink at the target bar earns +5 points, even if that team already claimed it.",
    targetNote: "Any bar except the finish bar.",
    targetToastBody: null,
    toasts: {
      announcement:
        "{Caster} played HAPPY HOUR on {Bar}! Until {endTime}, your team's first drink there earns +5 points, even if you've already claimed it.",
      end: "HAPPY HOUR at {Bar} has ended.",
    },
  },
  "party-crasher": {
    requires: null,
    effect:
      "Teams claiming the target bar score as if one extra team were sharing it. Once four teams have claimed it, the extra share disappears and each team scores 3.",
    targetNote:
      "A bar other than the finish bar that fewer than four teams have claimed.",
    targetToastBody: null,
    toasts: {
      announcement:
        "{Caster} played PARTY CRASHER on {Bar}! Teams claiming it score as if one extra team were sharing it.",
    },
  },
  "patient-investor": {
    requires: null,
    effect: "After your team claims four more bars, it gains 6 points.",
    targetNote: "Your own team.",
    targetToastBody: null,
    toasts: {
      payout: "{Caster} cashed in PATIENT INVESTOR for +6 points!",
    },
  },
  "power-hour": {
    requires: null,
    effect:
      "For the next 20 minutes, every team that claims a bar draws two cards and keeps both.",
    targetNote: "All teams.",
    targetToastBody: null,
    toasts: {
      announcement:
        "{Caster} played POWER HOUR! Until {endTime}, every team that claims a bar draws two cards and keeps both.",
      end: "POWER HOUR has ended. Draws are back to normal.",
    },
  },
  "voted-off-the-island": {
    requires:
      "Every team has claimed at least one bar other than the start bar.",
    effect:
      "The target team loses its claim on a bar that every team has claimed. They may re-claim it later.",
    targetNote: "An opposing team, plus a bar every team has claimed.",
    targetToastBody:
      "Your team's claim on {Bar} has been removed. You may re-claim it later.",
    toasts: {
      announcement:
        "{Caster} played VOTED OFF THE ISLAND on {Target} at {Bar}!",
    },
  },
};

function isNonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The slugs whose catalog `targetMode` is `"team"`. A plain data constant so the
 * module-load validation (1.4) does not depend on `catalog.ts`'s runtime
 * bindings: `catalog.ts` re-exports from this module, so importing its values
 * here at load time would form an initialization cycle. A catalog test
 * (Task 1.2) asserts this set matches the catalog metadata.
 */
const TEAM_TARGET_SLUGS: ReadonlySet<CardSlug> = new Set([
  "go-piss-girl",
  "moneybags",
  "use-it-or-lose-it",
  "wired",
  "art-school-dropout",
  "broad-shoulders",
  "bird-guide",
  "interested-buyer",
  "different-tastes",
  "everyones-a-critic",
  "pioneer",
  "spin-cycle",
  "dirty-bird",
  "scenic-route",
]);

/**
 * Validate and freeze the card-text map. Throws at module load when a card has a
 * blank `effect` or `targetNote`, or a blank `targetToastBody` for a card that
 * targets a team (1.4), so a card can never ship without usable text.
 */
export function createCardText(
  entries: Readonly<Record<CardSlug, CardText>>,
): ReadonlyMap<CardSlug, CardText> {
  const map = new Map<CardSlug, CardText>();
  for (const slug of Object.keys(entries) as CardSlug[]) {
    const text = entries[slug];
    if (text === undefined) {
      throw new Error(`card ${slug} is missing text`);
    }
    if (!isNonBlank(text.effect)) {
      throw new Error(`card ${slug} is missing an effect`);
    }
    if (!isNonBlank(text.targetNote)) {
      throw new Error(`card ${slug} is missing a target note`);
    }
    if (TEAM_TARGET_SLUGS.has(slug) && !isNonBlank(text.targetToastBody)) {
      throw new Error(`card ${slug} is missing a target toast body`);
    }
    map.set(slug, text);
  }
  return map;
}

export const CARD_TEXT_MAP = createCardText(CARD_TEXT_ENTRIES);

/**
 * The player-facing {@link CardText} for a card slug.
 *
 * @throws if the slug is unknown (every catalog slug is guaranteed to have text).
 */
export function getCardText(slug: CardSlug): CardText {
  const text = CARD_TEXT_MAP.get(slug);
  if (text === undefined) {
    throw new Error(`unknown card slug: ${slug}`);
  }
  return text;
}
