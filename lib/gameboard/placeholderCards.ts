/**
 * Placeholder card model for the Cards_Region and Card_Play_Wireframe (design.md
 * §Components 2, §Data Models).
 *
 * This feature implements **no** real card draw or hand logic — the Cards_Region
 * is a wireframe (R5). This module supplies a pure, deterministic placeholder
 * hand generator so the Cards_Region and the card-play wireframe have stable data
 * to render without any real draw logic (R5.2, R6.2/R6.3).
 *
 * The generator is seeded by `playerId` so a given Player always sees the same
 * placeholder hand, keeping the wireframe stable across renders and testable in
 * isolation (Property 7).
 *
 * NOTE: This is a Task 1 skeleton. The {@link PlaceholderCard} type is complete
 * and correct per the design; {@link placeholderHand} is filled in by Task 3.
 *
 * Requirements: 5.2, 6.2, 6.3.
 */

/**
 * One placeholder card in a wireframe hand (design.md §Data Models).
 */
export interface PlaceholderCard {
  readonly id: string;
  readonly label: string;
  /**
   * `true` ⇒ playing it targets another Team, which drives the target-selection
   * step of the Card_Play_Wireframe (R6.2); `false` ⇒ the wireframe omits target
   * selection and shows confirm directly (R6.3).
   */
  readonly targetsTeam: boolean;
}

/** The smallest placeholder hand a Player is ever dealt (R5.2). */
const MIN_HAND_SIZE = 1;
/** The largest placeholder hand a Player is ever dealt (R5.2). */
const MAX_HAND_SIZE = 8;

/**
 * A small pool of placeholder card labels the wireframe draws from. Purely
 * cosmetic — the real card catalog is owned by a later feature (F3.1) — but a
 * varied set keeps the Cards_Region legible while it is a wireframe.
 */
const PLACEHOLDER_LABELS = [
  "Detour",
  "Head Start",
  "Slowpoke",
  "Free Round",
  "Reroute",
  "Double Time",
  "Last Call",
  "Wrong Turn",
] as const;

/**
 * A stable 32-bit hash of a string (FNV-1a). Deterministic and framework-free so
 * a given `playerId` always seeds the same hand (Property 7). Returns an unsigned
 * 32-bit integer suitable for seeding {@link mulberry32}.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A tiny deterministic PRNG (mulberry32) yielding floats in [0, 1), matching the
 * pattern used elsewhere in the repo (`lib/realtime` property suites).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable placeholder hand of between 1 and 8 cards (R5.2), seeded by `playerId`
 * for determinism, with distinct ids and a mix of `targetsTeam` true/false.
 *
 * The hand is derived purely from a hash of `playerId`, so the same Player always
 * sees the same hand across renders and the generator is testable in isolation
 * (Property 7). The result always contains at least one targeting and one
 * non-targeting card so the Card_Play_Wireframe exercises both flows
 * (R6.2/R6.3), while ids are index-based and therefore distinct within the hand.
 *
 * @param playerId the Player whose wireframe hand to generate.
 * @returns a deterministic list of 1–8 {@link PlaceholderCard}s.
 */
export function placeholderHand(playerId: string): PlaceholderCard[] {
  const rng = mulberry32(hashString(playerId));

  // Choose a hand size in [MIN_HAND_SIZE, MAX_HAND_SIZE] inclusive.
  const span = MAX_HAND_SIZE - MIN_HAND_SIZE + 1;
  const size = MIN_HAND_SIZE + Math.floor(rng() * span);

  return Array.from({ length: size }, (_unused, index): PlaceholderCard => {
    // Guarantee a mix of targeting / non-targeting cards regardless of hand
    // size: force the first card to target and the second not to, then let the
    // seeded PRNG decide the rest. A one-card hand is intentionally a targeting
    // card so the target-selection flow is always reachable.
    let targetsTeam: boolean;
    if (index === 0) {
      targetsTeam = true;
    } else if (index === 1) {
      targetsTeam = false;
    } else {
      targetsTeam = rng() < 0.5;
    }

    const label = PLACEHOLDER_LABELS[index % PLACEHOLDER_LABELS.length];

    return {
      id: `placeholder-${playerId}-${index}`,
      label,
      targetsTeam,
    };
  });
}
