// @vitest-environment jsdom
//
// Mobile-viewport tests for the persistent branded Header_Nav (Task 10.1).
//
//   Requirement 7.2 — WHILE rendered on a viewport between 320 and 430 CSS
//     pixels wide, THE Header_Nav SHALL fit its content without horizontal
//     scrolling.
//
// NO ROUTER MOCK NEEDED:
//   Header_Nav is a plain server component whose brand row is wrapped in a
//   Next.js `<Link href="/">`, which renders to a plain `<a href="/">` in the
//   DOM. It has no client hooks, so it renders directly under jsdom (matching
//   HeaderNav.test.tsx) with no `next/navigation` mock.
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — `scrollWidth`,
//   `clientWidth`, `offsetWidth`, and `getBoundingClientRect()` all return 0, so
//   real horizontal overflow cannot be measured here; that needs a real
//   rendering engine (browser / Playwright), exercised elsewhere.
//
//   Mirroring the repo's viewport-test convention, these tests assert what IS
//   meaningfully checkable in jsdom:
//     1. The header renders at each narrow width without throwing and its
//        content (logo + tagline) is present and reachable, not clipped away.
//     2. No rendered element declares a fixed inline px width larger than the
//        viewport (the most direct cause of horizontal scroll), and the header's
//        fluid `maxWidth: 100%` fit guard is wired onto its structural elements
//        (R7.2).

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import HeaderNav from "./HeaderNav";

// The mobile viewport width band called out by Requirement 7.2: the two
// boundaries plus a common mid-band width.
const MOBILE_WIDTHS = [320, 375, 430] as const;

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects `window.innerWidth` reads; it documents the width under
 * test and guards against any width-dependent render logic the header may grow.
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
 * Parse a CSS px length (e.g. "40px") to a number, or null if the value is not
 * a plain px length (e.g. "100%", "", undefined).
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

describe("Header_Nav mobile viewport (Requirement 7.2)", () => {
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the logo and tagline, present and not clipped away", () => {
      setViewportWidth(width);
      render(<HeaderNav />);

      // Brand content survives at the narrow width: the logo (by alt text) and
      // the tagline are both present and reachable.
      expect(screen.getByAltText("Beltline Bar Brawl")).not.toBeNull();
      expect(
        screen.getByText("Race the Beltline. Claim the bars."),
      ).not.toBeNull();

      // The brand row is a home link, still reachable at the narrow width.
      expect(
        screen.getByRole("link", { name: /beltline bar brawl home/i }),
      ).not.toBeNull();
    });

    it("renders without throwing at the narrow viewport width", () => {
      setViewportWidth(width);
      expect(() => render(<HeaderNav />)).not.toThrow();
    });

    it("declares no fixed inline px width that would exceed the viewport (R7.2)", () => {
      setViewportWidth(width);
      const { container } = render(<HeaderNav />);

      // Best-effort overflow guard we CAN make in jsdom: no rendered element
      // carries an inline style with a fixed px width larger than the viewport,
      // which would be the most direct way to force horizontal scrolling. (The
      // logo's `width` is an HTML attribute, not an inline CSS `style.width`, so
      // it is intentionally not counted here.)
      const all = container.querySelectorAll<HTMLElement>("*");
      for (const el of all) {
        const px = parsePx(el.style.width);
        if (px !== null) {
          expect(px).toBeLessThanOrEqual(width);
        }
      }
    });

    it("caps the header and brand row at full-viewport width so they never overflow (R7.2)", () => {
      setViewportWidth(width);
      const { container } = render(<HeaderNav />);

      // The <header> is fluid and capped at 100% of its parent, so it scales
      // down to a narrow viewport rather than forcing horizontal scroll.
      const header = container.querySelector<HTMLElement>("header");
      expect(header).not.toBeNull();
      expect(header?.style.width).toBe("100%");
      expect(header?.style.maxWidth).toBe("100%");

      // The brand link inside also caps at 100%, so the logo + tagline row
      // cannot push the header wider than the viewport.
      const brandLink = container.querySelector<HTMLElement>("header a");
      expect(brandLink).not.toBeNull();
      expect(brandLink?.style.maxWidth).toBe("100%");
    });
  });
});
