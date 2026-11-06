import { describe, expect, it } from "vitest";

import type { BoardTeamView } from "@/lib/gameboard/events";

import {
  PHANTOM_SHARE_COLOR,
  PHANTOM_SHARE_TEAM_ID,
  colorSegments,
  segmentsToGradient,
  withPhantomSegment,
} from "./claims";

/**
 * A Party Crasher phantom share paints a black band into a bar's pin (an
 * unclaimed phantom bar becomes solid black), matching the scoring model where
 * the phantom shares the bar as if one more team were claiming it.
 */

const TEAMS: readonly BoardTeamView[] = [
  { id: "team-a", name: "Alpha", color: "#f00" },
  { id: "team-b", name: "Bravo", color: "#0f0" },
];

describe("withPhantomSegment", () => {
  it("returns the segments unchanged when there is no phantom", () => {
    const segments = colorSegments({ bar: ["team-a"] }, "bar", TEAMS);
    expect(withPhantomSegment(segments, false)).toBe(segments);
  });

  it("makes an unclaimed phantom bar a single solid black band", () => {
    const segments = colorSegments({}, "bar", TEAMS); // unclaimed → []
    const withPhantom = withPhantomSegment(segments, true);
    expect(withPhantom).toEqual([
      {
        teamId: PHANTOM_SHARE_TEAM_ID,
        color: PHANTOM_SHARE_COLOR,
        percent: 100,
      },
    ]);
    // Solid black fill.
    expect(segmentsToGradient(withPhantom)).toBe(PHANTOM_SHARE_COLOR);
  });

  it("adds one equal black band to a one-team bar (50/50)", () => {
    const segments = colorSegments({ bar: ["team-a"] }, "bar", TEAMS);
    const withPhantom = withPhantomSegment(segments, true);
    expect(withPhantom).toHaveLength(2);
    expect(withPhantom.every((s) => s.percent === 50)).toBe(true);
    expect(withPhantom[1]).toEqual({
      teamId: PHANTOM_SHARE_TEAM_ID,
      color: PHANTOM_SHARE_COLOR,
      percent: 50,
    });
    // The gradient carries the team color and the black band as hard edges.
    const gradient = segmentsToGradient(withPhantom);
    expect(gradient).toContain("#f00");
    expect(gradient).toContain(PHANTOM_SHARE_COLOR);
  });

  it("adds one equal black band to a two-team bar (thirds)", () => {
    const segments = colorSegments({ bar: ["team-a", "team-b"] }, "bar", TEAMS);
    const withPhantom = withPhantomSegment(segments, true);
    expect(withPhantom).toHaveLength(3);
    expect(withPhantom.every((s) => Math.abs(s.percent - 100 / 3) < 1e-9)).toBe(
      true,
    );
    expect(withPhantom[2].teamId).toBe(PHANTOM_SHARE_TEAM_ID);
  });
});
