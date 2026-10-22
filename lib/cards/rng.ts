/**
 * Deterministic, seedable RNG for per-team deck shuffling
 * (brawl-deck-architecture UAT hotfix: per-team shuffle streams).
 *
 * The Brawl Deck must be shuffled so each team's draw order is unpredictable,
 * but the shuffle must also be REPRODUCIBLE: a team's deck is seeded lazily and
 * re-derived on reload, so the same `(gameSeed, teamId)` pair must always yield
 * the same order (otherwise a reload would re-shuffle an in-progress deck). We
 * therefore avoid `Math.random` entirely and drive the shuffle from a small,
 * fast, well-distributed PRNG keyed by a string seed.
 *
 * Two pieces:
 *   - {@link hashStringToSeed} folds an arbitrary string (e.g.
 *     `"${gameSeed}:${teamId}"`) into a 32-bit integer via FNV-1a, so each team
 *     in a game gets a DIFFERENT stream and each game gets a different global
 *     seed.
 *   - {@link mulberry32} is a compact 32-bit PRNG returning floats in [0, 1).
 *   - {@link seededShuffle} is a Fisher–Yates shuffle driven by a PRNG, pure and
 *     non-mutating (it returns a new array).
 *
 * All three are pure and framework-free so they can be property-tested in
 * isolation and reused by both the engine and any future effect.
 */

/**
 * Fold a string into a 32-bit unsigned seed using FNV-1a. Deterministic and
 * order-sensitive, so `"a:b"` and `"b:a"` produce different seeds — giving each
 * team its own stream within a game and each game its own global seed.
 */
export function hashStringToSeed(input: string): number {
  // FNV-1a 32-bit. The offset basis / prime are the standard constants.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime (0x01000193) using 32-bit overflow arithmetic.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit integer.
  return hash >>> 0;
}

/**
 * The mulberry32 PRNG: a tiny, fast, statistically decent 32-bit generator. It
 * returns a stateful function yielding floats in [0, 1); identical seeds yield
 * identical sequences.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Return a new array that is a Fisher–Yates shuffle of `items`, driven by the
 * string `seed`. Pure: `items` is not mutated, and the same `(items, seed)`
 * always yields the same ordering.
 *
 * @param items the array to shuffle (left unchanged).
 * @param seed  a string seed; the same seed reproduces the same order.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const next = mulberry32(hashStringToSeed(seed));
  // Classic Fisher–Yates: walk from the end, swapping each element with a random
  // earlier (or equal) index drawn from the seeded stream.
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}
