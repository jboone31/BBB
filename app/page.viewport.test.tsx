// @vitest-environment jsdom
//
// Mobile-viewport tests for the branded Landing_Page (Task 10.1).
//
// This file replaces the foundation "baseline is running" viewport suite: the
// baseline splash was retired in Task 8, and `app/page.tsx` is now the branded
// Landing_Page that renders Host_Entry plus the Join_Entry client component
// (which calls `useRouter` from `next/navigation`). The suite is retargeted at
// the new page and the requirements it must satisfy:
//
//   Requirement 7.1 — WHILE rendered on a viewport between 320 and 430 CSS
//     pixels wide, THE Landing_Page SHALL fit its content without horizontal
//     scrolling.
//   Requirement 7.3 — THE Join_Entry submit control and Host_Entry control
//     SHALL each present a touch target of at least 44×44 CSS pixels.
//
// NEXT/NAVIGATION MOCK:
//   Join_Entry is a client component that calls `useRouter()` from
//   `next/navigation` at render time. Outside the Next.js App Router runtime
//   that hook throws ("invariant expected app router to be mounted"), so we
//   `vi.mock("next/navigation")` with a stub `useRouter` returning a no-op
//   `push`. That lets the whole Landing_Page render under jsdom without pulling
//   in the router runtime; these tests never navigate, so a no-op is faithful.
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — it does not
//   compute box sizes, so `scrollWidth`, `clientWidth`, `offsetWidth`, and
//   `getBoundingClientRect()` all return 0 and can never detect real horizontal
//   overflow. A faithful "does the page overflow at 320px?" assertion needs a
//   real rendering engine (browser / Playwright), exercised elsewhere, not here.
//
//   So, mirroring the repo's existing viewport-test convention, these tests
//   assert what IS meaningfully checkable in jsdom:
//     1. The Landing_Page renders at each narrow width without throwing and its
//        content (branding + both entry points) is present and reachable.
//     2. No rendered element declares a fixed inline px width larger than the
//        viewport (the most direct cause of horizontal scroll), and the fluid
//        `maxWidth: 100%` guards are wired onto the layout containers (R7.1).
//     3. The Host_Entry and Join_Entry submit controls each declare a
//        ≥ 44×44 CSS px touch target via their inline min-width/min-height
//        (R7.3) — inline styles jsdom can read directly.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Join_Entry calls useRouter() at render; stub next/navigation so the client
// component mounts under jsdom without the App Router runtime. push is a no-op —
// these viewport tests never navigate.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import HomePage from "./page";

// The mobile viewport width band called out by Requirement 7.1/7.2. We sample
// the two boundaries plus a common mid-band width.
const MOBILE_WIDTHS = [320, 375, 430] as const;

// Minimum touch-target edge required by Requirement 7.3.
const MIN_TOUCH_PX = 44;

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects `window.innerWidth` reads; it documents the width under
 * test and guards against any width-dependent render logic the page may grow.
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

/**
 * Parse a CSS px length (e.g. "44px") to a number, or null if the value is not
 * a plain px length (e.g. "100%", "44", "", undefined).
 */
function parsePx(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

afterEach(() => {
  cleanup();
});

describe("Landing_Page mobile viewport (Requirements 7.1, 7.3)", () => {
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the landing branding and both entry points, present and not clipped away", () => {
      setViewportWidth(width);
      render(<HomePage />);

      // The branded hero renders (logo + heading) — content is present, not
      // clipped out of existence.
      expect(screen.getByAltText("Beltline Bar Brawl")).not.toBeNull();
      expect(
        screen.getByRole("heading", { name: /beltline bar brawl/i }),
      ).not.toBeNull();

      // Host_Entry renders as a button-role link to the create surface (R2.1).
      const hostEntry = screen.getByRole("button", { name: /host a game/i });
      expect(hostEntry).not.toBeNull();

      // Join_Entry renders its code input and submit control (R2.1/R4.1).
      expect(
        screen.getByRole("textbox", { name: /join code/i }),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: /join game/i })).not.toBeNull();

      // The retired foundation splash text is gone.
      expect(screen.queryByText(/game features are on the way/i)).toBeNull();
    });

    it("renders without throwing at the narrow viewport width", () => {
      setViewportWidth(width);
      expect(() => render(<HomePage />)).not.toThrow();
    });

    it("declares no fixed inline px width that would exceed the viewport (R7.1)", () => {
      setViewportWidth(width);
      const { container } = render(<HomePage />);

      // Best-effort overflow guard we CAN make in jsdom: no rendered element
      // carries an inline style with a fixed px width larger than the viewport,
      // which would be the most direct way to force horizontal scrolling.
      const all = container.querySelectorAll<HTMLElement>("*");
      for (const el of all) {
        const px = parsePx(el.style.width);
        if (px !== null) {
          expect(px).toBeLessThanOrEqual(width);
        }
      }
    });

    it("caps the layout containers at fluid width so the column never exceeds the viewport (R7.1)", () => {
      setViewportWidth(width);
      const { container } = render(<HomePage />);

      // The <main> landing column is fluid (width:100%) and capped by a
      // max-width, so it scales down to a narrow viewport rather than forcing
      // horizontal scroll.
      const main = container.querySelector<HTMLElement>("main");
      expect(main).not.toBeNull();
      expect(main?.style.width).toBe("100%");
      // A max-width cap is declared so the column never grows unbounded. Because
      // width:100% dominates below the cap, the column always shrinks to fit a
      // narrow viewport regardless of the cap's unit.
      expect(main?.style.maxWidth).not.toBe("");
    });
  });

  // Touch-target assertions are viewport-independent: the inline min-width/
  // min-height declare the ≥44×44 CSS px floor jsdom can read directly.
  describe("entry controls expose ≥ 44×44 CSS px touch targets (Requirement 7.3)", () => {
    it("Host_Entry declares a ≥ 44×44px touch target", () => {
      render(<HomePage />);

      const hostEntry = screen.getByRole("button", { name: /host a game/i });
      const minWidth = parsePx(hostEntry.style.minWidth);
      const minHeight = parsePx(hostEntry.style.minHeight);
      expect(minWidth).not.toBeNull();
      expect(minHeight).not.toBeNull();
      expect(minWidth ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
      expect(minHeight ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    });

    it("Join_Entry submit control declares a ≥ 44×44px touch target", () => {
      render(<HomePage />);

      const submit = screen.getByRole("button", { name: /join game/i });
      const minWidth = parsePx(submit.style.minWidth);
      const minHeight = parsePx(submit.style.minHeight);
      expect(minWidth).not.toBeNull();
      expect(minHeight).not.toBeNull();
      expect(minWidth ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
      expect(minHeight ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    });
  });
});
