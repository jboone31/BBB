// @vitest-environment jsdom
//
// Viewport tests for the map's claim-blocked messaging (card-behavior Task 10.8).
//
// Requirement 24.5: THE Board_UI SHALL render the new toasts, prompts, and
// actions at the existing 320px and desktop viewport bands without clipping,
// operable by keyboard and touch. Requirements 3.10 / 4.5 put the
// "claim blocked" headline and each blocking card (with a timed block's end
// Clock_Time) in the bar's popup.
//
// LEAFLET IN JSDOM:
//   Leaflet needs real layout and tiles, so `react-leaflet` is replaced with
//   inert pass-through containers (MapContainer / Marker / Popup render their
//   children, TileLayer renders nothing) and `leaflet` with the two factories the
//   component calls. The popup CONTENT — the claim-blocked notice, the
//   attestation inputs, and the claim control — is the real component output.
//   Like the other *.viewport.test.tsx files, jsdom cannot measure overflow, so
//   we assert the notice renders at each band, carries no inline px width wider
//   than the viewport, keeps a ≥44px claim control, and is keyboard operable.

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimBlock } from "@/lib/claims/blocks";
import { CLAIM_BLOCKED_HEADLINE } from "@/lib/cards/toasts";
import type { BoardTeamView } from "@/lib/gameboard/events";
import { CANDIDATE_BARS } from "@/lib/map/bars";

vi.mock("leaflet/dist/leaflet.css", () => ({}));

vi.mock("leaflet", () => {
  const L = {
    latLngBounds: (a: unknown, b: unknown) => ({ a, b }),
    divIcon: (options: unknown) => options,
  };
  return { default: L, ...L };
});

vi.mock("react-leaflet", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    MapContainer: Pass,
    Marker: Pass,
    Popup: Pass,
    TileLayer: () => null,
    Circle: () => null,
    CircleMarker: () => null,
    Tooltip: () => null,
  };
});

import BarLeafletMap from "./BarLeafletMap";

const BANDS = [320, 1024, 1440] as const;

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#c0392b" },
  { id: "team-b", name: "Team Bravo", color: "#2980b9" },
];

const BLOCKED_BAR = CANDIDATE_BARS[0];

const BLOCKS: readonly ClaimBlock[] = [
  { kind: "challenge", slug: "wired", challengeId: "challenge-1" },
  {
    kind: "radius_lock",
    slug: "cancel-culture",
    effectId: "effect-1",
    endsAt: "2024-01-01T21:41:00.000Z",
  },
];

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

function renderMap() {
  const onMutate = vi.fn();
  const result = render(
    <BarLeafletMap
      claims={{}}
      teams={TEAMS}
      ownTeamId="team-a"
      onMutate={onMutate}
      claimBlocksByBar={{ [BLOCKED_BAR.id]: BLOCKS }}
    />,
  );
  return { ...result, onMutate };
}

/** The popup root for the blocked bar (the column holding its name). */
function blockedPopup(): HTMLElement {
  const name = screen.getByText(BLOCKED_BAR.name, { selector: "strong" });
  return name.parentElement as HTMLElement;
}

afterEach(cleanup);

describe("BarLeafletMap claim-blocked messaging viewport bands (Requirement 24.5)", () => {
  describe.each(BANDS)("at %dpx wide", (width) => {
    it("shows the claim-blocked headline and every blocking card in the bar's popup", () => {
      setViewportWidth(width);
      renderMap();

      const popup = blockedPopup();
      const notice = within(popup).getByRole("alert");
      expect(within(notice).getByText(CLAIM_BLOCKED_HEADLINE)).toBeTruthy();
      const items = within(notice).getAllByRole("listitem");
      expect(items.map((li) => li.textContent)).toEqual([
        expect.stringMatching(/^Wired — resolve the challenge first$/),
        expect.stringMatching(/^Cancel Culture — until /),
      ]);

      // Only the blocked bar carries the notice.
      expect(screen.getAllByText(CLAIM_BLOCKED_HEADLINE)).toHaveLength(1);
    });

    it("declares no inline px width wider than the viewport and keeps a ≥44px claim control", () => {
      setViewportWidth(width);
      const { container } = renderMap();

      for (const el of container.querySelectorAll<HTMLElement>("*")) {
        for (const raw of [el.style.width, el.style.minWidth]) {
          const px = pxValue(raw);
          if (px !== null) {
            expect(px).toBeLessThanOrEqual(width);
          }
        }
      }

      const popup = blockedPopup();
      // The popup column is sized in rem (fits a 320px viewport), not px.
      expect(popup.style.minWidth).toBe("10rem");
      const claim = within(popup).getByRole("button", {
        name: /claim for team alpha/i,
      });
      expect(pxValue(claim.style.minHeight) as number).toBeGreaterThanOrEqual(
        44,
      );
    });

    it("keeps the blocked popup's controls keyboard operable", async () => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { onMutate } = renderMap();

      const popup = blockedPopup();
      const present = within(popup).getByRole("checkbox", {
        name: /everyone is present/i,
      });
      const drinks = within(popup).getByRole("spinbutton", {
        name: new RegExp(`${BLOCKED_BAR.name} finished drinks`, "i"),
      });
      const claim = within(popup).getByRole("button", {
        name: /claim for team alpha/i,
      });

      // Tab order inside the popup: checkbox → drinks → claim.
      present.focus();
      await user.tab();
      expect(document.activeElement).toBe(drinks);
      await user.tab();
      expect(document.activeElement).toBe(claim);

      // The claim control stays enabled while blocked (the server's `blocked`
      // response is authoritative) and activates from Enter.
      await user.keyboard("{Enter}");
      expect(onMutate).toHaveBeenCalledWith(BLOCKED_BAR.id, "claim", {
        allMembersPresent: true,
        finishedDrinkCount: 1,
      });

      // Space toggles the attestation checkbox, which disables the claim.
      present.focus();
      await user.keyboard(" ");
      expect((present as HTMLInputElement).checked).toBe(false);
      expect((claim as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
