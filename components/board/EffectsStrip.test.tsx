// @vitest-environment jsdom
//
// Effects_Strip component tests (card-behavior Task 12.5; Requirement 20.7).
//
// The strip lists pending and active timed Effects with countdowns computed
// from server timestamps plus the Server_Clock_Offset. The device clock is
// injected (`now`) and deliberately skewed from server time so the tests prove
// the offset, not the raw device clock, drives the countdowns.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectRecord } from "@/lib/cards/effects";
import type { BoardTeamView } from "@/lib/gameboard/events";
import { CANDIDATE_BARS } from "@/lib/map/bars";

import EffectsStrip, {
  EFFECTS_STRIP_TICK_MS,
  formatCountdown,
  selectClaimCounterItems,
  selectEffectsStripItems,
} from "./EffectsStrip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SERVER_NOW = Date.parse("2025-06-01T20:00:00.000Z");
/** The device clock runs 90 s behind the server. */
const OFFSET_MS = 90_000;
const DEVICE_NOW = SERVER_NOW - OFFSET_MS;
const iso = (deltaMs: number): string =>
  new Date(SERVER_NOW + deltaMs).toISOString();

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: "Team Bravo", color: "#00f" },
];
const BAR = CANDIDATE_BARS[0]!;

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    effectId: "ef-1",
    slug: "crop-dusting",
    kind: "bar_lock",
    sourcePlayId: "play-1",
    sourceChallengeId: null,
    ownerTeamId: "team-a",
    targetTeamId: null,
    targetBarKey: BAR.id,
    startsAt: iso(-60_000),
    endsAt: iso(5 * 60_000),
    params: {},
    attachedClaimId: null,
    attachedBarKey: null,
    protectedPoints: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    startAnnounced: true,
    endAnnounced: false,
    ...overrides,
  };
}

describe("formatCountdown", () => {
  it("formats m:ss and h:mm:ss, rounding up and clamping at zero", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(64_001)).toBe("1:05");
    expect(formatCountdown(3_600_000 + 61_000)).toBe("1:01:01");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("selectEffectsStripItems", () => {
  it("keeps pending and timed active effects, ordered by countdown target", () => {
    const items = selectEffectsStripItems(
      [
        effect({ effectId: "active-late", endsAt: iso(10 * 60_000) }),
        effect({
          effectId: "pending",
          slug: "cancel-culture",
          kind: "radius_lock",
          startsAt: iso(2 * 60_000),
          endsAt: iso(17 * 60_000),
          startAnnounced: false,
        }),
        effect({ effectId: "untimed", kind: "phantom_share", endsAt: null }),
        effect({ effectId: "ended", endsAt: iso(-1_000) }),
        effect({ effectId: "cancelled", cancelledAt: iso(-1_000) }),
      ],
      SERVER_NOW,
    );
    expect(items.map((i) => [i.effectId, i.phase])).toEqual([
      ["pending", "pending"],
      ["active-late", "active"],
    ]);
  });
});

describe("EffectsStrip", () => {
  it("renders nothing when no timed effect is pending or active", () => {
    const { container } = render(
      <EffectsStrip
        effects={[effect({ endsAt: iso(-1) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("counts down from server time using the clock offset", () => {
    render(
      <EffectsStrip
        effects={[
          effect(),
          effect({
            effectId: "ef-2",
            slug: "cancel-culture",
            kind: "radius_lock",
            startsAt: iso(2 * 60_000 + 30_000),
            endsAt: iso(17 * 60_000 + 30_000),
            startAnnounced: false,
          }),
          effect({
            effectId: "ef-3",
            slug: "everyones-a-critic",
            kind: "team_claim_block",
            targetBarKey: null,
            targetTeamId: "team-b",
            endsAt: iso(15 * 60_000),
          }),
        ]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    const list = screen.getByRole("region", { name: "Effects" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // With device time used directly these would read 90 s longer.
    expect(items[0]!.textContent).toBe(
      `Cancel Culture at ${BAR.name}Starts in 2:30`,
    );
    expect(items[1]!.textContent).toBe(
      `Crop Dusting at ${BAR.name}Ends in 5:00`,
    );
    expect(items[2]!.textContent).toBe(
      "Everyone's a Critic on Team BravoEnds in 15:00",
    );
  });

  it("ticks every second and drops an effect once it ends", () => {
    vi.useFakeTimers();
    let device = DEVICE_NOW;
    render(
      <EffectsStrip
        effects={[effect({ endsAt: iso(2_000) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => device}
      />,
    );
    expect(screen.getByRole("listitem").textContent).toContain("Ends in 0:02");
    act(() => {
      device += EFFECTS_STRIP_TICK_MS;
      vi.advanceTimersByTime(EFFECTS_STRIP_TICK_MS);
    });
    expect(screen.getByRole("listitem").textContent).toContain("Ends in 0:01");
    act(() => {
      device += EFFECTS_STRIP_TICK_MS;
      vi.advanceTimersByTime(EFFECTS_STRIP_TICK_MS);
    });
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Patient Investor progress markers (untimed claim_counter effects).
// ---------------------------------------------------------------------------

function counter(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return effect({
    effectId: "ctr-1",
    slug: "patient-investor",
    kind: "claim_counter",
    ownerTeamId: "team-a",
    targetBarKey: null,
    startsAt: iso(-60_000),
    endsAt: null, // a counter is untimed
    params: { counted: [] },
    ...overrides,
  });
}

/** Build a `counted` params list of `n` distinct bars. */
function counted(n: number): {
  counted: { claimId: string; barKey: string }[];
} {
  return {
    counted: Array.from({ length: n }, (_, i) => ({
      claimId: `claim-${i}`,
      barKey: `bar-${i}`,
    })),
  };
}

describe("selectClaimCounterItems", () => {
  it("lists active counters with their distinct-bar count and threshold", () => {
    const items = selectClaimCounterItems([
      counter({ effectId: "ctr-1", params: counted(2) }),
      effect({ effectId: "timed", kind: "bar_lock" }), // not a counter
    ]);
    expect(items).toEqual([
      expect.objectContaining({ effectId: "ctr-1", counted: 2, threshold: 4 }),
    ]);
  });

  it("drops consumed or cancelled counters", () => {
    const items = selectClaimCounterItems([
      counter({
        effectId: "paid",
        consumedAt: iso(-1_000),
        params: counted(4),
      }),
      counter({
        effectId: "gone",
        cancelledAt: iso(-1_000),
        params: counted(1),
      }),
    ]);
    expect(items).toEqual([]);
  });
});

describe("EffectsStrip — Patient Investor marker", () => {
  it("shows N/4 progress for an active counter, visible with no timed effect", () => {
    render(
      <EffectsStrip
        effects={[counter({ params: counted(2) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    const markers = screen.getByRole("list", { name: /progress markers/i });
    const item = within(markers).getByRole("listitem");
    expect(item.textContent).toContain("Patient Investor");
    // Owner team name is shown so every team knows whose counter it is.
    expect(item.textContent).toContain("Team Alpha");
    expect(item.textContent).toContain("2/4 bars");
  });

  it("increments the marker as the counted list grows", () => {
    const { rerender } = render(
      <EffectsStrip
        effects={[counter({ params: counted(2) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    expect(screen.getByRole("listitem").textContent).toContain("2/4 bars");
    rerender(
      <EffectsStrip
        effects={[counter({ params: counted(3) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    expect(screen.getByRole("listitem").textContent).toContain("3/4 bars");
  });

  it("drops the marker once the counter pays out (is consumed)", () => {
    const { container } = render(
      <EffectsStrip
        effects={[counter({ consumedAt: iso(-1_000), params: counted(4) })]}
        offsetMs={OFFSET_MS}
        teams={TEAMS}
        now={() => DEVICE_NOW}
      />,
    );
    // No timed effect and no live counter → the strip renders nothing.
    expect(container.innerHTML).toBe("");
  });
});
