// @vitest-environment jsdom
//
// Mobile-viewport tests for the Lobby page (Task 22.1).
//
// Requirement 9.1: WHILE rendered on a viewport between 360 and 430 pixels
// wide, THE Lobby_Client SHALL present the create-game, join-game,
// team-selection, and start-game interfaces in a single-column layout whose
// content fits within the viewport width without horizontal scrolling.
//
// Requirement 9.2: THE Lobby_Client SHALL render each interactive control with
// a minimum touch target of 44 by 44 pixels.
//
// SCOPING NOTE — DOM environment:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts) because the foundation logic is framework-free. This
//   file opts into `jsdom` for THIS FILE ONLY via the `@vitest-environment
//   jsdom` docblock on line 1, mirroring app/page.viewport.test.tsx. The global
//   config is untouched.
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — `scrollWidth`,
//   `clientWidth`, `offsetWidth`, and `getBoundingClientRect()` all return 0, so
//   it can never *measure* real horizontal overflow or a rendered box's pixel
//   size. A faithful "does the lobby overflow at 390px?" assertion needs a real
//   rendering engine (browser / Playwright), exercised by environment-dependent
//   integration tasks, not here.
//
//   So — exactly as app/page.viewport.test.tsx does — these unit/example tests
//   assert what IS meaningfully testable in jsdom:
//     1. The page renders at representative 360–430px widths without throwing
//        and produces its content (heading + roster + an action interface), so
//        nothing is clipped out of existence.
//     2. The mobile-first guards that PREVENT horizontal overflow are actually
//        present on the rendered elements: a single-column flex container, a
//        border-box box model, fluid (non-fixed-px) widths capped at the
//        container, plus the globals.css html/body overflow-x guard.
//     3. Every interactive control (inputs + buttons) declares the ≥44px
//        minimum touch target (R9.2) via its `min-height`/`min-width`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Stub client-only dependencies so the page renders in jsdom -------------
//
// The lobby page pulls in next/navigation (useParams/useRouter) and the
// Supabase realtime/browser client. next/navigation throws outside a router
// context, so we mock it; the current game id is driven per-test through a
// mutable holder. The realtime effect is a no-op here because we leave Supabase
// unconfigured (isSupabaseConfigured() === false with no NEXT_PUBLIC_* env), so
// the page renders its "not configured" notice and never opens a connection —
// the same resilience path the demo page relies on.

const routeParams: { gameId: string } = { gameId: "" };
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import LobbyPage from "./page";

// The representative viewport widths spanning the 360–430px band (R9.1): the
// two common phone extremes plus a midpoint.
const MOBILE_WIDTHS = [360, 390, 430] as const;

// globals.css carries the html/body overflow-x guard; jsdom does not apply
// stylesheets to layout, so we assert on the stylesheet source directly (as
// app/page.viewport.test.tsx does). Resolve relative to the project root
// (Vitest runs with cwd = project root).
const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects width reads; it documents the width under test and
 * guards against any width-dependent render logic the page might grow later.
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

beforeEach(() => {
  // No Supabase env configured -> isSupabaseConfigured() is false -> the
  // realtime effect returns early and the page renders offline.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  pushMock.mockClear();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // ignore — storage is best-effort in the store under test too.
  }
});

afterEach(() => {
  cleanup();
});

describe("Lobby page mobile viewport (Requirements 9.1, 9.2)", () => {
  // The create surface (`/games/new/lobby`) renders the create-game interface;
  // the default lobby route (a bare, not-yet-joined, non-admin visitor with no
  // `?code=`) renders the full join-game interface. Both are exercised across
  // the 360–430px band. TeamSelection and StartGame are role/phase-gated inside
  // the page but are the same presentational family with identical ≥44px
  // controls, covered by the component tests.
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the create-game interface without throwing", () => {
      routeParams.gameId = "new";
      setViewportWidth(width);
      expect(() => render(<LobbyPage />)).not.toThrow();
      expect(
        screen.getByRole("heading", { name: /create a game/i }),
      ).not.toBeNull();
    });

    it("renders the join-game interface without throwing", () => {
      routeParams.gameId = "game-123";
      setViewportWidth(width);
      expect(() => render(<LobbyPage />)).not.toThrow();
      // The page shell heading is always present.
      expect(
        screen.getByRole("heading", { name: /beltline bar brawl/i }),
      ).not.toBeNull();
      // A bare visitor who has not joined and is not the admin (no `?code=`)
      // sees the full join-game interface (R9.1). The roster is member-gated —
      // it is intentionally NOT shown to a not-yet-joined, non-admin visitor
      // (RLS prevents them reading game state pre-join), so we do not assert it
      // here.
      expect(
        screen.getByRole("heading", { name: /join a game/i }),
      ).not.toBeNull();
      expect(screen.queryByRole("heading", { name: /^lobby$/i })).toBeNull();
    });

    it("lays out the page as a single column (flex column container)", () => {
      routeParams.gameId = "game-123";
      setViewportWidth(width);
      const { container } = render(<LobbyPage />);

      const main = container.querySelector("main");
      expect(main).not.toBeNull();
      // Single-column layout (R9.1): a vertical flex container.
      expect(main?.style.display).toBe("flex");
      expect(main?.style.flexDirection).toBe("column");
      // border-box keeps padding from pushing the container past its cap, the
      // classic narrow-viewport overflow cause.
      expect(main?.style.boxSizing).toBe("border-box");
    });

    it("declares no fixed pixel width wider than the viewport", () => {
      routeParams.gameId = "game-123";
      setViewportWidth(width);
      const { container } = render(<LobbyPage />);

      // Best-effort overflow guard available in jsdom: no rendered element sets
      // an inline `width`/`min-width` in px that exceeds the viewport width —
      // the most direct way to force horizontal scrolling. (The page/components
      // use `width: 100%` and rem caps, so there should be none.)
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
      routeParams.gameId = "game-123";
      setViewportWidth(width);
      const { container } = render(<LobbyPage />);

      const controls = container.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href]",
      );
      // The join interface renders interactive controls; ensure we actually
      // asserted against some (guards against a silent empty match).
      expect(controls.length).toBeGreaterThan(0);

      for (const control of controls) {
        // Height: an explicit min-height (the components use `minHeight: 44px`)
        // or an explicit height, must be ≥44px.
        const minH = pxValue(control.style.minHeight);
        const h = pxValue(control.style.height);
        const effectiveHeight = minH ?? h;
        expect(effectiveHeight).not.toBeNull();
        expect(effectiveHeight as number).toBeGreaterThanOrEqual(44);

        // Width target (R9.2): full-width controls satisfy the 44px minimum on a
        // ≥360px viewport; otherwise an explicit px min-width/width must be
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

  // Viewport-independent: the html/body overflow-x guard that keeps the whole
  // page within the viewport lives in globals.css, which jsdom does not apply to
  // layout. Assert its presence directly (mirrors app/page.viewport.test.tsx).
  describe("global overflow guards are present (R9.1)", () => {
    it("guards html/body against horizontal overflow", () => {
      expect(GLOBALS_CSS).toMatch(/overflow-x:\s*hidden/);
      expect(GLOBALS_CSS).toMatch(/max-width:\s*100%/);
    });

    it("applies a universal border-box box model", () => {
      expect(GLOBALS_CSS).toMatch(/box-sizing:\s*border-box/);
    });
  });

  // Sanity: the create surface's control (the create-game submit button) also
  // meets the touch target, so the create-game interface is covered too (R9.2).
  it("the create-game interface's controls meet the ≥44px touch target", () => {
    routeParams.gameId = "new";
    setViewportWidth(390);
    const { container } = render(<LobbyPage />);

    const controls = container.querySelectorAll<HTMLElement>(
      "button, input, select, textarea",
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const effectiveHeight =
        pxValue(control.style.minHeight) ?? pxValue(control.style.height);
      expect(effectiveHeight).not.toBeNull();
      expect(effectiveHeight as number).toBeGreaterThanOrEqual(44);
    }
    // The create-game interface rendered its inputs (start/finish bar).
    expect(within(container).getAllByRole("textbox").length).toBeGreaterThan(0);
  });
});
