// @vitest-environment jsdom
//
// Mobile-viewport test for the Card_Play_Wireframe (Task 13.2).
//
// Requirement 9.4: WHILE rendered on a viewport between 320 and 430 pixels
// wide, THE Card_Play_Wireframe SHALL present its content within the viewport
// width without horizontal scrolling.
//
// SCOPING NOTE — DOM environment:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts) because the foundation logic is framework-free. This
//   file opts into `jsdom` for THIS FILE ONLY via the `@vitest-environment
//   jsdom` docblock on line 1, mirroring app/games/[gameId]/lobby/
//   page.viewport.test.tsx. The global config is untouched.
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — `scrollWidth`,
//   `clientWidth`, `offsetWidth`, and `getBoundingClientRect()` all return 0, so
//   it can never *measure* real horizontal overflow or a rendered box's pixel
//   size. A faithful "does the wireframe overflow at 320px?" assertion needs a
//   real rendering engine (browser / Playwright), exercised by environment-
//   dependent integration tasks, not here.
//
//   So — exactly as the lobby viewport test does — this test asserts what IS
//   meaningfully testable in jsdom:
//     1. The wireframe renders across the 320–430px band without throwing and
//        produces its content, so nothing is clipped out of existence.
//     2. The mobile-first guards that PREVENT horizontal overflow are actually
//        present on the rendered root: a single-column flex container, a
//        border-box box model (inherited via globals.css), and fluid
//        (non-fixed-px) widths capped at the container (`width: 100%`,
//        `max-width: 100%`), with no rendered element pinning a px width wider
//        than the viewport.
//     3. Every interactive control declares the ≥44×44px minimum touch target
//        (R9.4) via its `min-height`/`min-width`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardTeamView } from "@/lib/gameboard/events";
import type { PlaceholderCard } from "@/lib/gameboard/placeholderCards";

import CardPlayWireframe from "./CardPlayWireframe";

afterEach(() => {
  cleanup();
});

// The representative viewport widths spanning the 320–430px band (R9.4): the
// narrow small-phone extreme, a common midpoint, and the wide extreme.
const MOBILE_WIDTHS = [320, 375, 430] as const;

// globals.css carries the universal border-box box model and the html/body
// overflow-x guard; jsdom does not apply stylesheets to layout, so we assert on
// the stylesheet source directly (as the lobby viewport test does). Resolve
// relative to the project root (Vitest runs with cwd = project root).
const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/** A targeting placeholder card — drives the fullest render (target list). */
const TARGETING_CARD: PlaceholderCard = {
  id: "placeholder-card",
  label: "Detour",
  targetsTeam: true,
};

/** A few Teams so the target list renders multiple option controls. */
const TEAMS: readonly BoardTeamView[] = [
  { id: "t-own", name: "Team Own", color: "#e11" },
  { id: "t-red", name: "Team Red", color: "#1a1" },
  { id: "t-blue", name: "Team Blue", color: "#11e" },
] as const;

const OWN_TEAM_ID = "t-own";

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects width reads; it documents the width under test and
 * guards against any width-dependent render logic the component might grow.
 */
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

/** Parse a CSS pixel length like "44px" into a number, or null when not px. */
function pxValue(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

function renderWireframe() {
  return render(
    <CardPlayWireframe
      card={TARGETING_CARD}
      teams={TEAMS}
      ownTeamId={OWN_TEAM_ID}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("Card_Play_Wireframe mobile viewport (Requirement 9.4)", () => {
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the wireframe without throwing", () => {
      setViewportWidth(width);
      expect(() => renderWireframe()).not.toThrow();
    });

    it("presents the play dialog with its content", () => {
      setViewportWidth(width);
      const { container } = renderWireframe();
      // The wireframe root is a role="dialog" carrying the card label, so its
      // content is present (nothing clipped out of existence).
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent ?? "").toContain("Detour");
    });

    it("lays out as a single column that fits the container (flex column, border-box, fluid width)", () => {
      setViewportWidth(width);
      const { container } = renderWireframe();

      const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      // Single-column layout (R9.4): a vertical flex container.
      expect(dialog?.style.display).toBe("flex");
      expect(dialog?.style.flexDirection).toBe("column");
      // Fluid, capped width: no fixed px width — fills its parent and is capped
      // at 100%, so it can never exceed the viewport the parent lives in.
      expect(dialog?.style.width).toBe("100%");
      expect(dialog?.style.maxWidth).toBe("100%");
    });

    it("declares no fixed pixel width wider than the viewport", () => {
      setViewportWidth(width);
      const { container } = renderWireframe();

      // Best-effort overflow guard available in jsdom: no rendered element sets
      // an inline `width`/`min-width` in px that exceeds the viewport width —
      // the most direct way to force horizontal scrolling. The component uses
      // `width: 100%` and rem-based padding, and the only px `min-width`/
      // `min-height` are the 44px touch targets (well under 320px).
      const all = container.querySelectorAll<HTMLElement>("*");
      for (const el of all) {
        const w = pxValue(el.style.width);
        if (w !== null) {
          expect(w).toBeLessThanOrEqual(width);
        }
        const minW = pxValue(el.style.minWidth);
        if (minW !== null) {
          expect(minW).toBeLessThanOrEqual(width);
        }
      }
    });

    it("gives every interactive control a ≥44×44px touch target", () => {
      setViewportWidth(width);
      const { container } = renderWireframe();

      const controls =
        container.querySelectorAll<HTMLElement>("button, a[href]");
      // The targeting flow renders target options plus confirm/cancel; guard
      // against a silent empty match.
      expect(controls.length).toBeGreaterThan(0);

      for (const control of controls) {
        // Height: an explicit min-height (the component uses `minHeight: 44px`)
        // or an explicit height, must be ≥44px.
        const minH = pxValue(control.style.minHeight);
        const h = pxValue(control.style.height);
        const effectiveHeight = minH ?? h;
        expect(effectiveHeight).not.toBeNull();
        expect(effectiveHeight as number).toBeGreaterThanOrEqual(44);

        // Width target (R9.4): full-width controls satisfy the 44px minimum on a
        // ≥320px viewport; otherwise an explicit px min-width/width must be
        // ≥44px. No control may pin a px width below 44px.
        const isFullWidth =
          control.style.width === "100%" || control.style.width === "auto";
        const minW = pxValue(control.style.minWidth);
        const w = pxValue(control.style.width);
        if (!isFullWidth) {
          const effectiveWidth = minW ?? w;
          if (effectiveWidth !== null) {
            expect(effectiveWidth).toBeGreaterThanOrEqual(44);
          }
        }
      }
    });
  });

  // Viewport-independent: the universal border-box box model and the html/body
  // overflow-x guard that keep the wireframe within the viewport live in
  // globals.css, which jsdom does not apply to layout. Assert their presence
  // directly (mirrors the lobby viewport test).
  describe("global overflow guards are present (R9.4)", () => {
    it("applies a universal border-box box model the wireframe inherits", () => {
      expect(GLOBALS_CSS).toMatch(/box-sizing:\s*border-box/);
    });

    it("guards html/body against horizontal overflow", () => {
      expect(GLOBALS_CSS).toMatch(/overflow-x:\s*hidden/);
      expect(GLOBALS_CSS).toMatch(/max-width:\s*100%/);
    });
  });
});
