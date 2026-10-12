export const CARD_SLUGS = [
  "go-piss-girl",
  "crop-dusting",
  "moneybags",
  "use-it-or-lose-it",
  "wired",
  "art-school-dropout",
  "broad-shoulders",
  "bird-guide",
  "interested-buyer",
  "different-tastes",
  "everyones-a-critic",
  "fairest-of-them-all",
  "pioneer",
  "cancel-culture",
  "spin-cycle",
  "dirty-bird",
  "scenic-route",
  "insurance",
  "happy-hour",
  "party-crasher",
  "patient-investor",
  "power-hour",
  "voted-off-the-island",
] as const;

export type CardSlug = (typeof CARD_SLUGS)[number];
export type CardCategory = "opponent_slowing" | "economy_boost" | "reactive";
export type CardTargetMode =
  "team" | "bar" | "self" | "none" | "team_and_bar" | "reactive";
export type CardInput =
  "none" | "bar" | "public_bar" | "colors" | "duration_seconds" | "cuisine";
export type CardResolution =
  "none" | "manual_confirmation" | "manual_result" | "reactive_mirror";
export type CardAudience =
  "caster" | "target" | "all" | "other_teams" | "uninvolved_teams";
export type CardDomainFamily =
  | "challenges"
  | "claims"
  | "effects"
  | "inventory"
  | "notifications"
  | "scores";

export interface CardMetadata {
  readonly slug: CardSlug;
  readonly name: string;
  readonly category: CardCategory;
  readonly targetMode: CardTargetMode;
  readonly castingInput: CardInput;
  readonly resolution: CardResolution;
  readonly completionRequired: boolean;
  readonly timerSeconds: number | null;
  readonly persistent: boolean;
  readonly consumable: boolean;
  readonly reactive: boolean;
  readonly audiences: readonly CardAudience[];
  readonly affectedDomains: readonly CardDomainFamily[];
}

const TEAM_CHALLENGE_AUDIENCES = [
  "caster",
  "target",
  "uninvolved_teams",
] as const;

const TEAM_CHALLENGE_DOMAINS = [
  "challenges",
  "claims",
  "notifications",
] as const;

const TEAM_CHALLENGE = {
  category: "opponent_slowing",
  targetMode: "team",
  castingInput: "none",
  resolution: "manual_confirmation",
  completionRequired: true,
  timerSeconds: null,
  persistent: false,
  consumable: true,
  reactive: false,
  audiences: TEAM_CHALLENGE_AUDIENCES,
  affectedDomains: TEAM_CHALLENGE_DOMAINS,
} as const;

const CARD_CATALOG: readonly CardMetadata[] = [
  { slug: "go-piss-girl", name: "Go Piss Girl", ...TEAM_CHALLENGE },
  {
    slug: "crop-dusting",
    name: "Crop Dusting",
    category: "opponent_slowing",
    targetMode: "bar",
    castingInput: "bar",
    resolution: "none",
    completionRequired: false,
    timerSeconds: 900,
    persistent: false,
    consumable: true,
    reactive: false,
    audiences: ["caster", "all"],
    affectedDomains: ["claims", "effects", "notifications"],
  },
  { slug: "moneybags", name: "Moneybags", ...TEAM_CHALLENGE },
  {
    slug: "use-it-or-lose-it",
    name: "Use It or Lose It",
    ...TEAM_CHALLENGE,
    resolution: "manual_result",
    affectedDomains: ["challenges", "claims", "inventory", "notifications"],
  },
  { slug: "wired", name: "Wired", ...TEAM_CHALLENGE },
  {
    slug: "art-school-dropout",
    name: "Art School Dropout",
    ...TEAM_CHALLENGE,
    castingInput: "colors",
  },
  { slug: "broad-shoulders", name: "Broad Shoulders", ...TEAM_CHALLENGE },
  {
    slug: "bird-guide",
    name: "Bird Guide",
    ...TEAM_CHALLENGE,
    castingInput: "duration_seconds",
  },
  { slug: "interested-buyer", name: "Interested Buyer", ...TEAM_CHALLENGE },
  {
    slug: "different-tastes",
    name: "Different Tastes",
    ...TEAM_CHALLENGE,
    castingInput: "cuisine",
  },
  {
    slug: "everyones-a-critic",
    name: "Everyone's a Critic",
    ...TEAM_CHALLENGE,
    resolution: "manual_result",
    affectedDomains: ["challenges", "claims", "effects", "notifications"],
  },
  {
    slug: "fairest-of-them-all",
    name: "Fairest of Them All",
    category: "reactive",
    targetMode: "reactive",
    castingInput: "none",
    resolution: "reactive_mirror",
    completionRequired: true,
    timerSeconds: null,
    persistent: false,
    consumable: true,
    reactive: true,
    audiences: ["caster", "target", "uninvolved_teams"],
    affectedDomains: ["challenges", "notifications"],
  },
  {
    slug: "pioneer",
    name: "Pioneer",
    ...TEAM_CHALLENGE,
    resolution: "none",
    affectedDomains: ["claims", "effects", "notifications"],
  },
  {
    slug: "cancel-culture",
    name: "Cancel Culture",
    category: "opponent_slowing",
    targetMode: "bar",
    castingInput: "public_bar",
    resolution: "none",
    completionRequired: false,
    timerSeconds: 900,
    persistent: true,
    consumable: true,
    reactive: false,
    audiences: ["caster", "all"],
    affectedDomains: ["claims", "effects", "notifications"],
  },
  { slug: "spin-cycle", name: "Spin Cycle", ...TEAM_CHALLENGE },
  { slug: "dirty-bird", name: "Dirty Bird", ...TEAM_CHALLENGE },
  {
    slug: "scenic-route",
    name: "Scenic Route",
    ...TEAM_CHALLENGE,
    resolution: "none",
    affectedDomains: ["claims", "effects", "notifications"],
  },
  {
    slug: "insurance",
    name: "Insurance",
    category: "economy_boost",
    targetMode: "self",
    castingInput: "none",
    resolution: "none",
    completionRequired: false,
    timerSeconds: null,
    persistent: false,
    consumable: true,
    reactive: false,
    audiences: ["caster", "other_teams"],
    affectedDomains: ["effects", "scores", "notifications"],
  },
  {
    slug: "happy-hour",
    name: "Happy Hour",
    category: "economy_boost",
    targetMode: "bar",
    castingInput: "bar",
    resolution: "manual_confirmation",
    completionRequired: true,
    timerSeconds: 3600,
    persistent: true,
    consumable: true,
    reactive: false,
    audiences: ["caster", "all"],
    affectedDomains: ["claims", "effects", "scores", "notifications"],
  },
  {
    slug: "party-crasher",
    name: "Party Crasher",
    category: "economy_boost",
    targetMode: "bar",
    castingInput: "bar",
    resolution: "none",
    completionRequired: false,
    timerSeconds: null,
    persistent: true,
    consumable: true,
    reactive: false,
    audiences: ["caster", "all"],
    affectedDomains: ["effects", "scores", "notifications"],
  },
  {
    slug: "patient-investor",
    name: "Patient Investor",
    category: "economy_boost",
    targetMode: "self",
    castingInput: "none",
    resolution: "none",
    completionRequired: false,
    timerSeconds: null,
    persistent: true,
    consumable: true,
    reactive: false,
    audiences: ["caster", "other_teams"],
    affectedDomains: ["claims", "effects", "scores", "notifications"],
  },
  {
    slug: "power-hour",
    name: "Power Hour",
    category: "economy_boost",
    targetMode: "none",
    castingInput: "none",
    resolution: "none",
    completionRequired: false,
    timerSeconds: 1200,
    persistent: true,
    consumable: true,
    reactive: false,
    audiences: ["all"],
    affectedDomains: ["effects", "inventory", "notifications"],
  },
  {
    slug: "voted-off-the-island",
    name: "Voted Off the Island",
    ...TEAM_CHALLENGE,
    targetMode: "team_and_bar",
    castingInput: "bar",
    resolution: "manual_confirmation",
    affectedDomains: ["challenges", "claims", "notifications"],
  },
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateCardMetadata(value: CardMetadata): void {
  if (!isNonEmptyString(value.slug) || !isNonEmptyString(value.name)) {
    throw new Error("card metadata requires a non-empty slug and name");
  }
  if (
    value.timerSeconds !== null &&
    (!Number.isInteger(value.timerSeconds) || value.timerSeconds <= 0)
  ) {
    throw new Error(`card ${value.slug} has an invalid timer`);
  }
  if (value.targetMode === "team" && value.castingInput === "bar") {
    throw new Error(`card ${value.slug} has an incompatible team target input`);
  }
  if (value.targetMode === "reactive" && !value.reactive) {
    throw new Error(`card ${value.slug} must be marked reactive`);
  }
  if (value.reactive && value.targetMode !== "reactive") {
    throw new Error(
      `card ${value.slug} has reactive metadata without reactive targeting`,
    );
  }
  if (value.audiences.length === 0 || value.affectedDomains.length === 0) {
    throw new Error(
      `card ${value.slug} must declare audiences and affected domains`,
    );
  }
}

export function createCardCatalog(
  entries: readonly CardMetadata[],
): ReadonlyMap<CardSlug, CardMetadata> {
  const catalog = new Map<CardSlug, CardMetadata>();
  for (const entry of entries) {
    validateCardMetadata(entry);
    if (catalog.has(entry.slug)) {
      throw new Error(`duplicate card slug: ${entry.slug}`);
    }
    catalog.set(entry.slug, entry);
  }
  return catalog;
}

export const CARD_CATALOG_MAP = createCardCatalog(CARD_CATALOG);

export function getCardMetadata(slug: CardSlug): CardMetadata {
  const metadata = CARD_CATALOG_MAP.get(slug);
  if (metadata === undefined) {
    throw new Error(`unknown card slug: ${slug}`);
  }
  return metadata;
}

export { CARD_CATALOG };

// ---------------------------------------------------------------------------
// Human-readable card text (brawl-deck-architecture Task 7)
// ---------------------------------------------------------------------------

/**
 * The player-facing text for a card, kept client-side so the hand-inspection UI
 * (R2.2) can render it with no server round-trip and no live dependency.
 *
 * Three fields model the card's lifecycle:
 *   - `description`: what the card does.
 *   - `castingRequirement`: what the CASTING team must satisfy to play it. The
 *     card cannot be played unless this is met (enforced in later tasks). `null`
 *     when the card has no casting condition.
 *   - `targetRequirement`: what the TARGET team must complete to resolve the
 *     challenge. Until the target acknowledges completion it is blocked from
 *     claiming bars (enforced in later tasks). `null` when the card imposes no
 *     target challenge (e.g. self/economy effects).
 *
 * NOTE: the strings below are deliberate PLACEHOLDERS. The finalized card text
 * is still being authored; these exist only so the UI has the right SHAPE to
 * render. The real text drops into {@link CARD_TEXT_ENTRIES} with no code change.
 * Do not treat these as authoritative gameplay copy.
 */
export interface CardText {
  /** Placeholder description of what the card does. */
  readonly description: string;
  /** Placeholder casting-team requirement, or null if the card has none. */
  readonly castingRequirement: string | null;
  /** Placeholder target-team challenge requirement, or null if the card has none. */
  readonly targetRequirement: string | null;
}

/**
 * Build a placeholder {@link CardText} for a slug. Which requirement fields are
 * present is derived from the card's real {@link CardMetadata.targetMode} /
 * casting input so the placeholder has a faithful SHAPE (a team-targeting
 * challenge gets a target requirement; a card that needs a casting input gets a
 * casting requirement; a bare self/none economy card gets neither), even though
 * the copy itself is a stand-in.
 */
function placeholderCardText(slug: CardSlug): CardText {
  const meta = CARD_CATALOG_MAP.get(slug);
  const name = meta?.name ?? slug;
  const mode = meta?.targetMode ?? "none";
  const hasTargetChallenge =
    mode === "team" || mode === "team_and_bar" || mode === "reactive";
  const hasCastingInput = meta !== undefined && meta.castingInput !== "none";
  return {
    description: `[Placeholder] Description for "${name}" — final card text pending.`,
    castingRequirement: hasCastingInput
      ? `[Placeholder] Casting requirement for "${name}" — final text pending.`
      : null,
    targetRequirement: hasTargetChallenge
      ? `[Placeholder] Target-team challenge for "${name}" — final text pending.`
      : null,
  };
}

/**
 * Card text keyed by slug. Every {@link CardSlug} has an entry (defaulted to a
 * {@link placeholderCardText} stand-in); {@link createCardText} enforces that at
 * module load, so a new card cannot ship without text. Replace an entry here
 * with the finalized `{ description, castingRequirement, targetRequirement }`
 * when the real copy is authored.
 */
const CARD_TEXT_ENTRIES: Readonly<Record<CardSlug, CardText>> =
  Object.fromEntries(
    CARD_SLUGS.map((slug) => [slug, placeholderCardText(slug)]),
  ) as Record<CardSlug, CardText>;

/** Validate and freeze the card-text map: every slug must have a description. */
function createCardText(
  entries: Readonly<Record<CardSlug, CardText>>,
): ReadonlyMap<CardSlug, CardText> {
  const map = new Map<CardSlug, CardText>();
  for (const slug of CARD_SLUGS) {
    const text = entries[slug];
    if (text === undefined || !isNonEmptyString(text.description)) {
      throw new Error(`card ${slug} is missing a description`);
    }
    map.set(slug, {
      description: text.description,
      castingRequirement:
        text.castingRequirement !== null &&
        isNonEmptyString(text.castingRequirement)
          ? text.castingRequirement
          : null,
      targetRequirement:
        text.targetRequirement !== null &&
        isNonEmptyString(text.targetRequirement)
          ? text.targetRequirement
          : null,
    });
  }
  return map;
}

export const CARD_TEXT_MAP = createCardText(CARD_TEXT_ENTRIES);

/**
 * The player-facing {@link CardText} for a card slug (R2.2).
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
