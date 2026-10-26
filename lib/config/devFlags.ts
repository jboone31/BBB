/**
 * Committed, PR-controlled development flags.
 *
 * These are **not** environment variables. Each flag is a plain compile-time
 * constant in this file, so changing one requires editing source and landing a
 * pull request — deliberately simulating a "dev build" versus a "prod build"
 * without any runtime configuration surface (Requirement 5.1).
 *
 * Why a committed constant rather than `process.env`:
 *  - The capability it gates (dev-only card injection, Requirement 5.2/5.3) must be
 *    *provably* off in production. A boolean baked into the shipped bundle cannot be
 *    flipped by a stray environment variable, a `.env.local`, or a Vercel setting;
 *    turning it on is a reviewable code change.
 *  - Both the client (whether to render the inject button) and the server (whether
 *    to authorize the inject route) read the exact same constant, so the UI and the
 *    enforcement can never disagree.
 *
 * This module intentionally wires no behavior to the flags yet; it only declares
 * them and exposes typed accessors. Consumers land in later tasks.
 */

/**
 * The full set of committed dev flags and their current values.
 *
 * Frozen so no code can mutate a flag at runtime: the only way to change a value
 * is to edit the literal below and open a PR (Requirement 5.1).
 */
export const DEV_FLAGS = Object.freeze({
  /**
   * Dev-only "add card to hand" capability (Requirement 5.2/5.3).
   *
   * When `false` the inject button is not rendered and the inject route refuses
   * the operation even if called directly. When `true` both are enabled.
   *
   * ⚠️ REMINDER: this is currently `true` for prototype testing on the Vercel
   * deployment. Flip it back to `false` once you're done exercising card
   * injection — leaving it on lets anyone with the board open force cards into a
   * hand, bypassing the normal claim/draw flow.
   */
  DEV_CARD_INJECTION: true,
} as const);

/** The name of a committed dev flag. */
export type DevFlag = keyof typeof DEV_FLAGS;

/**
 * Read a committed dev flag.
 *
 * This is the single accessor both the client and the server use so they always
 * agree on a flag's value. It reads straight from the frozen {@link DEV_FLAGS}
 * constant — there is no environment or runtime input.
 *
 * @param flag - The flag to read.
 * @returns the flag's committed boolean value.
 */
export function isDevFlagEnabled(flag: DevFlag): boolean {
  return DEV_FLAGS[flag];
}

/**
 * Convenience accessor for the dev-only card-injection capability
 * (Requirement 5.2/5.3). Equivalent to `isDevFlagEnabled("DEV_CARD_INJECTION")`.
 */
export function isDevCardInjectionEnabled(): boolean {
  return isDevFlagEnabled("DEV_CARD_INJECTION");
}
