// @vitest-environment jsdom
//
// Viewport tests for the card-behavior Effects_Strip (card-behavior Task 12.6).
//
// Requirement 20.7: the Board_UI shows pending and active timed Effects with
// countdowns computed from server timestamps and the Server_Clock_Offset.
// Requirement 24.5: THE Board_UI SHALL render the new toasts, prompts, and
// actions at the existing 320px and desktop viewport bands without clipping.
//
// JSDOM LAYOUT LIMITATION (same as the repo's other *.viewport.test.tsx files):
//   jsdom performs no layout, so real overflow cannot be measured. These tests
//   assert what IS checkable in jsdom at each band:
//     1. Every listed Effect renders with its subject and its server-offset
//        countdown, so nothing is clipped out of existence.
//     2. The overflow guards are wired: fluid `width: 100%` + `min-width: 0` +
//        `box-sizing: border-box` on the strip, wrapping rows with
//        `overflow-wrap: anywhere` for long names, and no inline px width
//        wider than the viewport.
//     3. The once-per-second countdown is not a live region, so screen readers
//        are not interrupted on every tick.

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EffectRecord } from "@/lib/cards/effects";
import type { BoardTeamView } from "@/lib/gameboard/events";
import { CANDIDATE_BARS } from "@/lib/map/bars";

import EffectsStrip from "./EffectsStrip";

/** The narrow small-phone floor and two representative desktop widths. */
const BANDS = [320, 1024, 1440] as const;

const SERVER_NOW = Date.parse("2025-06-01T20:00:00.000Z");
/** The device clock runs 90 s behind the server. */
const OFFSET_MS = 90_000;
const DEVICE_NOW = SERVER_NOW - OFFSET_MS;
const iso = (deltaMs: number): string =>
  new Date(SERVER_NOW + deltaMs).toISOString();

// A deliberately long, unbroken team name: without `overflow-wrap: anywhere`
// it would push a 320px row wider than the viewport.
const LONG_NAME = "Supercalifragilisticexpialidocious".repeat(4);

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: LONG_NAME, color: "#00f" },
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

function effects(): EffectRecord[] {
  return [
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
    effect({
      effectId: "ef-4",
      slug: "happy-hour",
      kind: "bonus_window",
      startsAt: iso(-60_000),
      endsAt: iso(59 * 60_000),
    }),
  ];
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function pxValue(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

function renderStrip() {
  return render(
    <EffectsStrip
      effects={effects()}
      offsetMs={OFFSET_MS}
      teams={TEAMS}
      now={() => DEVICE_NOW}
    />,
  );
}

afterEach(cleanup);

describe("EffectsStrip viewport bands (Requirements 20.7, 24.5)", () => {
  describe.each(BANDS)("at %dpx wide", (width) => {
    it("renders every timed effect with its server-offset countdown", () => {
      setViewportWidth(width);
      renderStrip();

      const region = screen.getByRole("region", { name: "Effects" });
      const items = within(region).getAllByRole("listitem");
      expect(items).toHaveLength(4);
      // Device time used directly would read 90 s longer on each countdown.
      expect(items[0]!.textContent).toBe(
        `Cancel Culture at ${BAR.name}Starts in 2:30`,
      );
      expect(items[1]!.textContent).toBe(
        `Crop Dusting at ${BAR.name}Ends in 5:00`,
      );
      expect(items[2]!.textContent).toBe(
        `Everyone's a Critic on ${LONG_NAME}Ends in 15:00`,
      );
      expect(items[3]!.textContent).toBe(
        `Happy Hour at ${BAR.name}Ends in 59:00`,
      );
      for (const item of items) {
        expect(item.querySelector("time")).not.toBeNull();
      }
    });

    it("wires the no-clipping guards on the strip and each row", () => {
      setViewportWidth(width);
      const { container } = renderStrip();

      const region = screen.getByRole("region", { name: "Effects" });
      expect(region.style.width).toBe("100%");
      expect(region.style.minWidth).toMatch(/^0(px)?$/);
      expect(region.style.boxSizing).toBe("border-box");

      const list = region.querySelector("ul") as HTMLElement;
      expect(list.style.flexDirection).toBe("column");

      for (const item of within(region).getAllByRole("listitem")) {
        expect(item.style.flexWrap).toBe("wrap");
        expect(item.style.minWidth).toMatch(/^0(px)?$/);
        expect(item.style.overflowWrap).toBe("anywhere");
        // The label span may shrink below its content width.
        const label = item.firstElementChild as HTMLElement;
        expect(label.style.minWidth).toMatch(/^0(px)?$/);
      }

      // The long unbroken team name sits inside a row that breaks anywhere.
      const longRow = screen
        .getByText(new RegExp(LONG_NAME))
        .closest("li") as HTMLElement;
      expect(longRow.style.overflowWrap).toBe("anywhere");

      // No inline px width/min-width wider than the viewport.
      for (const el of container.querySelectorAll<HTMLElement>("*")) {
        for (const raw of [el.style.width, el.style.minWidth]) {
          const px = pxValue(raw);
          if (px !== null) {
            expect(px).toBeLessThanOrEqual(width);
          }
        }
      }
    });

    it("is not a disruptive live region", () => {
      setViewportWidth(width);
      const { container } = renderStrip();

      expect(container.querySelector("[aria-live]")).toBeNull();
      expect(
        container.querySelector(
          '[role="alert"], [role="status"], [role="log"], [role="timer"], [role="marquee"]',
        ),
      ).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("timer")).toBeNull();
    });
  });
});
