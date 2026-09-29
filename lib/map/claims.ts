/**
 * Pure claim-state + color-split logic for the Map_Region wireframe
 * (framework-free).
 *
 * The map lets a player tap a bar pin and claim/unclaim it for a team. This
 * module is the pure core of that interaction, kept out of the React component
 * so it can be unit-tested in isolation:
 *
 *   - {@link ClaimState} maps a bar id to the ordered list of team ids currently
 *     claiming it.
 *   - {@link toggleClaim} claims a bar for a team if it isn't already, or
 *     unclaims it if it is — this is what a pin tap does.
 *   - {@link claimingTeams} / {@link colorSegments} turn a bar's claimers into the
 *     visual split shown on the pin: the pin color is divided equally among the
 *     claiming teams (1 team = solid, 2 = halves, 3 = thirds, 4 = quarters).
 *
 * This is a wireframe: nothing here persists, writes a Game_Event, or affects
 * scoring. It is local UI state only.
 */

import type { BoardTeamView } from "@/lib/gameboard/events";

/**
 * Fallback wireframe teams used when the live game exposes no folded Teams (e.g.
 * the board is running without a configured realtime backend). Four teams so the
 * 2/3/4-way color split can be exercised. Real games pass their own
 * {@link BoardTeamView}[] instead.
 */
export const WIREFRAME_TEAMS: readonly BoardTeamView[] = [
  { id: "team-red", name: "Red", color: "#e6194b" },
  { id: "team-blue", name: "Blue", color: "#4363d8" },
  { id: "team-green", name: "Green", color: "#3cb44b" },
  { id: "team-yellow", name: "Yellow", color: "#ffe119" },
] as const;

/**
 * Per-bar claim state: bar id → ordered list of claiming team ids. Absence of a
 * key (or an empty list) means the bar is unclaimed. Order is claim order and is
 * only used to keep the color segments stable as teams join/leave.
 */
export type ClaimState = Readonly<Record<string, readonly string[]>>;

/** The empty starting claim state — every bar unclaimed. */
export const EMPTY_CLAIMS: ClaimState = {};

/** The team ids currently claiming `barId` (empty when unclaimed). */
export function claimersOf(
  state: ClaimState,
  barId: string,
): readonly string[] {
  return state[barId] ?? [];
}

/** Whether `teamId` currently claims `barId`. */
export function isClaimedBy(
  state: ClaimState,
  barId: string,
  teamId: string,
): boolean {
  return claimersOf(state, barId).includes(teamId);
}

/**
 * Toggle a team's claim on a bar: if the team already claims it, unclaim (remove
 * the team); otherwise claim (append the team). Returns a new {@link ClaimState};
 * the input is never mutated. When the last claimer of a bar unclaims, the bar's
 * key is dropped so it reads as unclaimed again.
 */
export function toggleClaim(
  state: ClaimState,
  barId: string,
  teamId: string,
): ClaimState {
  const current = claimersOf(state, barId);
  const next = current.includes(teamId)
    ? current.filter((id) => id !== teamId)
    : [...current, teamId];

  const copy: Record<string, readonly string[]> = { ...state };
  if (next.length === 0) {
    delete copy[barId];
  } else {
    copy[barId] = next;
  }
  return copy;
}

/**
 * Resolve the {@link BoardTeamView}s claiming a bar, in claim order, filtered to
 * teams that still exist in `teams`. Used to render the pin's color split.
 */
export function claimingTeams(
  state: ClaimState,
  barId: string,
  teams: readonly BoardTeamView[],
): readonly BoardTeamView[] {
  const byId = new Map(teams.map((t) => [t.id, t]));
  return claimersOf(state, barId)
    .map((id) => byId.get(id))
    .filter((t): t is BoardTeamView => t !== undefined);
}

/** One equal slice of a pin's fill for a single claiming team. */
export interface ColorSegment {
  readonly teamId: string;
  readonly color: string;
  /** Equal share of the pin, in percent (100 for 1 team, 50 for 2, etc.). */
  readonly percent: number;
}

/**
 * Split a bar's pin fill equally among its claiming teams (R: multiple teams
 * split the color 2/3/4 ways). Returns one {@link ColorSegment} per claiming
 * team, each with an equal `percent` share; an unclaimed bar returns an empty
 * array (the pin renders in its neutral unclaimed style).
 */
export function colorSegments(
  state: ClaimState,
  barId: string,
  teams: readonly BoardTeamView[],
): readonly ColorSegment[] {
  const claimers = claimingTeams(state, barId, teams);
  if (claimers.length === 0) {
    return [];
  }
  const percent = 100 / claimers.length;
  return claimers.map((team) => ({
    teamId: team.id,
    color: team.color,
    percent,
  }));
}

/**
 * Build a CSS `linear-gradient(...)` value that paints a pin as hard-edged equal
 * bands, one per claiming team (left→right). One team yields a solid fill; N
 * teams yield N equal vertical bands. Returns `null` when unclaimed so the caller
 * can apply its neutral style.
 */
export function segmentsToGradient(
  segments: readonly ColorSegment[],
): string | null {
  if (segments.length === 0) {
    return null;
  }
  if (segments.length === 1) {
    return segments[0].color;
  }
  const stops: string[] = [];
  let acc = 0;
  for (const seg of segments) {
    const start = acc;
    const end = acc + seg.percent;
    // Hard edges: repeat the color at both the start and end of its band.
    stops.push(`${seg.color} ${start}%`, `${seg.color} ${end}%`);
    acc = end;
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
