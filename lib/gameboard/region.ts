/**
 * Active-Region transition logic for the Game_Board (design.md §Components 3;
 * R2).
 *
 * The Game_Board presents exactly three navigable Regions — the Bars_Region, the
 * Scoreboard_Region, and the Cards_Region — and displays exactly one of them as
 * active at any time (R2.6). This module is the pure, framework-free core of that
 * navigation: the {@link Region} union, the initial active Region ({@link
 * INITIAL_REGION}, `"bars"`, R2.3), and {@link selectRegion}, which makes the
 * target Region active (R2.2) and is a no-op when the target is already active
 * (R2.7).
 *
 * Keeping the transition pure lets it be property-tested in isolation
 * (Properties 2 and 3) independent of the React component that renders the nav.
 *
 * Requirements: 2.2, 2.3, 2.6, 2.7.
 */

/** One of the three primary navigable areas of the Game_Board (R2.1). */
export type Region = "bars" | "scoreboard" | "cards";

/**
 * The Region made active when the Game_Board first renders for a Live_Game
 * (R2.3).
 */
export const INITIAL_REGION: Region = "bars";

/**
 * Select the active Region: make `target` the active Region (R2.2). Selecting
 * the Region that is already active returns an equal state — no change to which
 * Region is displayed (R2.7).
 *
 * @param current the currently active Region.
 * @param target  the Region the Player activated.
 * @returns the new active Region.
 */
export function selectRegion(current: Region, target: Region): Region {
  // The active Region is a plain string union with no surrounding state, so
  // activating the target simply yields the target. When `target === current`
  // this returns a value equal to `current`, so re-selecting the active Region
  // is a no-op (R2.7); the `current` parameter is otherwise unused because the
  // prior active Region has no bearing on the next one (R2.2).
  void current;
  return target;
}
