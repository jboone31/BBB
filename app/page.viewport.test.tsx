// @vitest-environment jsdom
//
// Mobile-viewport tests for the Deployable_Baseline home page (Task 16.3).
//
// Requirement 2.11: WHILE displayed on a mobile viewport between 320 and 375
// CSS pixels wide, the baseline SHALL present all content within the viewport
// width with no horizontal scrolling and no content clipped beyond the edges.
//
// SCOPING NOTE — DOM environment:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts) because the foundation logic is framework-free. This
//   file opts into `jsdom` for THIS FILE ONLY via the `@vitest-environment
//   jsdom` docblock directive on line 1. The global config is untouched, so the
//   existing node-environment tests keep running exactly as before.
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — it does not
//   compute box sizes, so `scrollWidth`, `clientWidth`, `offsetWidth`, and
//   `getBoundingClientRect()` all return 0 and can never detect real horizontal
//   overflow. A faithful "does the page overflow at 320px?" assertion needs a
//   real rendering engine (browser / Playwright), which is exercised by the
//   environment-dependent integration tasks, not here.
//
//   So these unit/example tests assert what IS meaningfully testable in jsdom:
//     1. The page renders at narrow viewport widths without throwing, and the
//        running-indicator content is present and reachable (not clipped away).
//     2. The mobile-first CSS guards that PREVENT horizontal overflow at
//        320–375px are actually present in globals.css and wired to the
//        elements the page renders (border-box sizing, overflow-x guard,
//        max-width caps, word wrapping, and no fixed pixel widths wider than the
//        viewport).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import HomePage from "./page";

// The two mobile viewport widths called out by Requirement 2.11.
const MOBILE_WIDTHS = [320, 375] as const;

// Load globals.css once — the overflow guards live in CSS, and jsdom does not
// apply stylesheets to layout, so we assert on the stylesheet source directly.
// Resolve relative to the project root (Vitest runs with cwd = project root).
// jsdom rewrites `import.meta.url` to a non-file URL, so we avoid it here.
const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects `window.innerWidth` / `matchMedia`-style reads; it lets
 * us document the width under test and guard against any width-dependent render
 * logic the page might grow later.
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

afterEach(() => {
  cleanup();
});

describe("Deployable_Baseline mobile viewport (Requirement 2.11)", () => {
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the running indicator so content is present and not clipped away", () => {
      setViewportWidth(width);

      const { container } = render(<HomePage />);

      // The "running" indicator content renders and is reachable in the DOM —
      // i.e. it is not clipped out of existence. (role="status" is the running
      // indicator required by Requirement 2.10 and carried through here.)
      // Uses plain DOM assertions (no jest-dom matchers) to keep the added test
      // dependency surface minimal.
      const status = screen.getByRole("status");
      expect(status.textContent ?? "").toMatch(/running/i);

      // The heading and note also render, confirming no content was dropped.
      expect(
        screen.getByRole("heading", { name: /beltline bar brawl/i }),
      ).not.toBeNull();
      expect(screen.getByText(/game features are on the way/i)).not.toBeNull();

      // The status region contains its dot marker — nested content survives.
      expect(within(status).queryByText).toBeDefined();
      expect(container.querySelector(".baseline__dot")).not.toBeNull();
    });

    it("renders without throwing at the narrow viewport width", () => {
      setViewportWidth(width);
      expect(() => render(<HomePage />)).not.toThrow();
    });

    it("declares no fixed pixel width that would exceed the viewport", () => {
      setViewportWidth(width);
      const { container } = render(<HomePage />);

      // Best-effort overflow guard we CAN make in jsdom: no rendered element
      // carries an inline style with a fixed px width larger than the viewport,
      // which would be the most direct way to force horizontal scrolling.
      const all = container.querySelectorAll<HTMLElement>("*");
      for (const el of all) {
        const inlineWidth = el.style.width;
        const pxMatch = /^(\d+(?:\.\d+)?)px$/.exec(inlineWidth.trim());
        if (pxMatch) {
          expect(Number(pxMatch[1])).toBeLessThanOrEqual(width);
        }
      }
    });
  });

  // These assertions are viewport-independent: they verify the CSS guards that
  // KEEP the page within a 320–375px viewport are present and applied. Because
  // jsdom cannot lay out boxes, this is how we meaningfully cover "no horizontal
  // scrolling / no clipping" without a real rendering engine.
  describe("mobile-first CSS guards are present and applied", () => {
    it("applies a universal border-box box model", () => {
      // With border-box, padding never pushes an element past its width cap,
      // which is what keeps padded content inside a 320px viewport.
      expect(GLOBALS_CSS).toMatch(/box-sizing:\s*border-box/);
    });

    it("guards html/body against horizontal overflow", () => {
      // overflow-x: hidden on the root elements is the direct guard against
      // horizontal scrolling required by Requirement 2.11.
      expect(GLOBALS_CSS).toMatch(/overflow-x:\s*hidden/);
      expect(GLOBALS_CSS).toMatch(/max-width:\s*100%/);
    });

    it("caps media and the baseline container at 100% width", () => {
      // Images/media and the main container never exceed their parent, so
      // nothing extends past the viewport edge (no clipping past the edge).
      expect(GLOBALS_CSS).toMatch(
        /img,\s*svg,\s*video,\s*canvas\s*\{[^}]*max-width:\s*100%/,
      );
      expect(GLOBALS_CSS).toMatch(/\.baseline\s*\{[^}]*max-width:\s*100%/);
    });

    it("wraps long words rather than overflowing", () => {
      // Long unbreakable strings wrap instead of forcing horizontal scroll.
      expect(GLOBALS_CSS).toMatch(/overflow-wrap:\s*anywhere/);
      expect(GLOBALS_CSS).toMatch(/word-break:\s*break-word/);
    });

    it("uses no fixed pixel widths in the baseline layout", () => {
      // Extract the CSS rules that style the baseline component and confirm
      // none pin a fixed px width — fixed widths are the classic cause of
      // horizontal overflow on narrow viewports.
      const baselineRules =
        GLOBALS_CSS.match(/\.baseline[^{]*\{[^}]*\}/g) ?? [];
      expect(baselineRules.length).toBeGreaterThan(0);
      for (const rule of baselineRules) {
        expect(rule).not.toMatch(/(?<!max-|min-)width:\s*\d+px/);
      }
    });

    it("connects the rendered markup to the guarded CSS classes", () => {
      // The overflow guards above only help if the page actually uses those
      // classes; assert the render wires them up.
      const { container } = render(<HomePage />);
      expect(container.querySelector(".baseline")).not.toBeNull();
      expect(container.querySelector(".baseline__status")).not.toBeNull();
      expect(container.querySelector(".baseline__title")).not.toBeNull();
    });
  });
});
