// @vitest-environment jsdom
//
// Mobile-viewport tests for the Game_Board page (Task 13.1).
//
// Requirement 9.1: WHILE rendered on a viewport between 320 and 430 pixels
// wide, THE Game_Board_Client SHALL present its Regions in a single-column
// layout whose content fits within the viewport width without horizontal
// scrolling.
//
// Requirement 9.2: THE Game_Board_Client SHALL render each interactive control
// (the Region navigation controls, the claim control, the card play controls,
// and a notification dismiss control) with a minimum touch target of 44 by 44
// pixels.
//
// Requirement 9.3: THE claim / card-play / dismiss controls each expose a
// ≥44×44px touch target.
//
// Requirement 9.5: WHILE a Targeted_Notification is active, THE Game_Board SHALL
// leave the Region navigation controls present and operable (the inline,
// non-modal notification never obscures the nav).
//
// SCOPING NOTE — DOM environment + mocked seams:
//   The project's Vitest harness defaults to the `node` environment (see
//   vitest.config.mts) because the foundation logic is framework-free. This file
//   opts into `jsdom` for THIS FILE ONLY via the `@vitest-environment jsdom`
//   docblock on line 1, mirroring `app/games/[gameId]/lobby/page.viewport.test.tsx`.
//   The global config is untouched.
//
//   Unlike the lobby's offline-render viewport test, the Game_Board only renders
//   its Regions in the `board` access decision — a live game with a Session that
//   is an Admin or Player (selectBoardAccess). So this file takes the CONFIGURED
//   realtime path with the same seams the lobby orchestration test fakes:
//     - `next/navigation` (useParams/useRouter) mocked;
//     - `@/lib/realtime/supabaseBrowser` configured, with a controllable snapshot
//       source that returns the game's event log (a `game_started` fold → the
//       `live` lifecycle the access gate requires);
//     - `@/lib/realtime` `subscribe` inert (no live channel);
//     - `@/lib/session/supabaseSession` `establishBrowserSession` resolving a
//       session id the page adopts;
//     - an in-memory `localStorage` carrying `bbb:player:{gameId}` so the Session
//       is a Player of the game (access === "board").
//
// JSDOM LAYOUT LIMITATION:
//   jsdom implements the DOM API but performs NO real layout — `scrollWidth`,
//   `clientWidth`, `offsetWidth`, and `getBoundingClientRect()` all return 0, so
//   it can never *measure* real horizontal overflow or a rendered box's pixel
//   size. A faithful "does the board overflow at 390px?" assertion needs a real
//   rendering engine (browser / Playwright), exercised by environment-dependent
//   integration tasks, not here.
//
//   So — exactly as the lobby viewport test does — these unit/example tests
//   assert what IS meaningfully testable in jsdom:
//     1. The board renders at representative 320–430px widths without throwing
//        and produces its Regions (RegionNav + the active Bars region), so
//        nothing is clipped out of existence.
//     2. The mobile-first guards that PREVENT horizontal overflow are actually
//        present on the rendered elements: a single-column flex container, a
//        border-box box model, fluid (non-fixed-px) widths capped at the
//        container, plus the globals.css html/body overflow-x guard.
//     3. Every interactive control (nav, claim, card-play, dismiss) declares the
//        ≥44px minimum touch target (R9.2/R9.3) via its `min-height`/`min-width`.
//     4. With a Targeted_Notification active, the RegionNav controls remain
//        present and operable (R9.5).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameEvent } from "@/lib/events";
import { establishBrowserSession } from "@/lib/session/supabaseSession";

// The session id the mocked Supabase-auth bootstrap resolves. The page adopts
// this UID as its BBB session id and derives its role facts from it.
const SESSION_ID = "sess-board-viewport";

// --- next/navigation: route param + router.push capture ---------------------
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

// --- realtime seams: configured, with a controllable snapshot --------------
//
// The board only renders its Regions in the `board` access decision, which needs
// a live lifecycle. We take the CONFIGURED path and drive `view.lifecycle` from
// the folded snapshot (a `game_started` event → `live`). `subscribe` is inert so
// no live channel opens; the reconnect/resume controllers are constructed but
// never fire in the test.

let snapshotEvents: GameEvent[] = [];

vi.mock("@/lib/realtime/supabaseBrowser", () => ({
  isSupabaseConfigured: () => true,
  createBrowserSupabaseClient: () => ({}) as unknown,
  supabaseRealtimeTransport: () => ({
    channel: () => ({ unsubscribe: async () => {} }),
  }),
  supabaseSnapshotSource: () => ({
    fetchEventsAscending: async () => snapshotEvents,
  }),
}));

vi.mock("@/lib/realtime", () => ({
  subscribe: async () => ({
    snapshot: { lastSeenSequence: 0 },
    close: async () => {},
  }),
}));

vi.mock("@/lib/realtime/lastSeenStore", () => ({
  LocalStorageLastSeenStore: class {
    get() {
      return null;
    }
    set() {}
  },
}));

vi.mock("@/lib/realtime/reconnect", () => ({
  ReconnectPhase: {
    Idle: "idle",
    Reconnecting: "reconnecting",
    Connected: "connected",
    ReloadRequired: "reload-required",
  },
  ReconnectController: class {
    stop() {}
  },
  makeReconnectAttempt: () => async () => {},
}));

vi.mock("@/lib/realtime/resume", () => ({
  ResumeController: class {},
  bindResumeSignals: () => () => {},
}));

// Mock the Supabase-auth session bridge: the page adopts the resolved
// `sessionId` and gates its subscription/POST on it.
vi.mock("@/lib/session/supabaseSession", () => ({
  establishBrowserSession: vi.fn(async () => ({
    sessionId: SESSION_ID,
    accessToken: "test-token",
  })),
  bindRealtimeAuth: vi.fn(() => () => {}),
}));

import BoardPage from "./page";

// The representative viewport widths spanning the 320–430px band (R9.1): the
// narrow small-phone floor (320), two common phone widths, and the 430 ceiling.
const MOBILE_WIDTHS = [320, 360, 390, 430] as const;

const GAME_ID = "game-board-vp";

// A minimal live-game event log: the game is created with a Team, a second Team
// is created (so a target list exists), then the game is started (→ `live`, the
// lifecycle the access gate requires). Team ids/colors let the scoreboard and
// target list render if visited.
function liveSnapshot(gameId: string): GameEvent[] {
  return [
    {
      id: `evt-${gameId}-1`,
      gameId,
      seq: 1,
      eventType: "game_created",
      actorKind: "admin",
      actorTeamId: null,
      payload: { teamId: "team-a", name: "Team A", color: "#c0392b" },
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: `evt-${gameId}-2`,
      gameId,
      seq: 2,
      eventType: "team_created",
      actorKind: "admin",
      actorTeamId: null,
      payload: { teamId: "team-b", name: "Team B", color: "#2980b9" },
      createdAt: "2024-01-01T00:00:01.000Z",
    },
    {
      id: `evt-${gameId}-3`,
      gameId,
      seq: 3,
      eventType: "game_started",
      actorKind: "admin",
      actorTeamId: null,
      payload: {},
      createdAt: "2024-01-01T00:00:02.000Z",
    },
  ];
}

// globals.css carries the html/body overflow-x guard; jsdom does not apply
// stylesheets to layout, so we assert on the stylesheet source directly (as the
// lobby viewport test does). Resolve relative to the project root (Vitest runs
// with cwd = project root).
const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "app", "globals.css"),
  "utf8",
);

/**
 * Set the jsdom "viewport" to a given CSS-pixel width. jsdom does not lay out,
 * so this only affects width reads; it documents the width under test and guards
 * against any width-dependent render logic the page might grow later.
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

/**
 * Install a real, callable in-memory `localStorage` for the duration of a test.
 * The project's jsdom harness exposes a `localStorage` whose getItem/setItem are
 * not usable here, so a Map-backed stub gives the page a working durable store
 * (matching the lobby orchestration test). Seed `bbb:player:{gameId}` so the
 * Session is a Player of the game (access === "board").
 */
function installMemoryLocalStorage(seed: Record<string, string> = {}): void {
  const map = new Map<string, string>(Object.entries(seed));
  const storage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    clear: (): void => {
      map.clear();
    },
    key: (index: number): string | null => [...map.keys()][index] ?? null,
    get length(): number {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

/**
 * Render the board in its "board" access state (live member) and wait for the
 * async session bootstrap + snapshot fold to settle so the Regions render.
 * Returns the render result once the RegionNav is present.
 */
async function renderLiveBoard(): Promise<ReturnType<typeof render>> {
  const result = render(<BoardPage />);
  // The RegionNav appears once the async session resolves (isPlayer via the
  // seeded player fact) and the snapshot folds to `live`.
  await screen.findByRole("navigation", { name: /game board regions/i });
  return result;
}

beforeEach(() => {
  routeParams.gameId = GAME_ID;
  snapshotEvents = liveSnapshot(GAME_ID);
  pushMock.mockClear();
  vi.mocked(establishBrowserSession).mockClear();
  // Seed the durable Player fact so selectBoardAccess resolves to "board".
  installMemoryLocalStorage({ [`bbb:player:${GAME_ID}`]: "player-1" });
});

afterEach(() => {
  cleanup();
});

describe("Game_Board page mobile viewport (Requirements 9.1, 9.2, 9.3, 9.5)", () => {
  describe.each(MOBILE_WIDTHS)("at %dpx wide", (width) => {
    it("renders the live board with its Region navigation without throwing", async () => {
      setViewportWidth(width);
      let result: ReturnType<typeof render> | undefined;
      await expect(
        (async () => {
          result = await renderLiveBoard();
        })(),
      ).resolves.toBeUndefined();
      // The three-control Region nav and the initial Bars region are present, so
      // the board is not clipped out of existence (R9.1).
      const nav = within(result!.container).getByRole("navigation", {
        name: /game board regions/i,
      });
      expect(within(nav).getAllByRole("button").length).toBe(3);
      expect(
        screen.getByRole("region", { name: /^bars$/i }),
      ).not.toBeNull();
    });

    it("lays out the page as a single column (border-box flex column container)", async () => {
      setViewportWidth(width);
      const { container } = await renderLiveBoard();

      const main = container.querySelector("main");
      expect(main).not.toBeNull();
      // Single-column layout (R9.1): a vertical flex container.
      expect(main?.style.display).toBe("flex");
      expect(main?.style.flexDirection).toBe("column");
      // border-box keeps padding from pushing the container past its cap, the
      // classic narrow-viewport overflow cause.
      expect(main?.style.boxSizing).toBe("border-box");
    });

    it("declares no fixed pixel width wider than the viewport", async () => {
      setViewportWidth(width);
      const { container } = await renderLiveBoard();

      // Best-effort overflow guard available in jsdom: no rendered element sets
      // an inline `width`/`min-width` in px that exceeds the viewport width — the
      // most direct way to force horizontal scrolling. The board container caps
      // at a rem max-width and its children use `width: 100%`/rem, so there
      // should be none. (Controls pin a 44px min-width, well under 320.)
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

    it("gives every interactive control a ≥44×44px touch target", async () => {
      setViewportWidth(width);
      const { container } = await renderLiveBoard();

      const controls = container.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href]",
      );
      // The live board renders interactive controls (nav + the Bars claim
      // control); ensure we actually asserted against some.
      expect(controls.length).toBeGreaterThan(0);

      for (const control of controls) {
        // Height: an explicit min-height (the components use `minHeight: 44px`)
        // or an explicit height, must be ≥44px.
        const minH = pxValue(control.style.minHeight);
        const h = pxValue(control.style.height);
        const effectiveHeight = minH ?? h;
        expect(effectiveHeight).not.toBeNull();
        expect(effectiveHeight as number).toBeGreaterThanOrEqual(44);

        // Width target (R9.2): full-width / flex controls satisfy the 44px
        // minimum on a ≥320px viewport; otherwise an explicit px min-width/width
        // must be ≥44px. No control may pin a px width below 44px.
        const minW = pxValue(control.style.minWidth);
        const w = pxValue(control.style.width);
        const effectiveWidth = minW ?? w;
        if (effectiveWidth !== null) {
          expect(effectiveWidth).toBeGreaterThanOrEqual(44);
        }
      }
    });
  });

  // Cross-region control coverage at a representative width: every Region's
  // interactive controls (nav, claim, card-play, dismiss) meet the ≥44×44px
  // target (R9.2/R9.3). Rendered at 390px so we visit each Region in turn.
  describe("every interactive control across Regions meets the ≥44×44px target (R9.2/R9.3)", () => {
    /** Assert every currently-rendered interactive control is ≥44×44px. */
    function assertAllControlsTouchTarget(container: HTMLElement): void {
      const controls = container.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href]",
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        const effectiveHeight =
          pxValue(control.style.minHeight) ?? pxValue(control.style.height);
        expect(effectiveHeight).not.toBeNull();
        expect(effectiveHeight as number).toBeGreaterThanOrEqual(44);
        const effectiveWidth =
          pxValue(control.style.minWidth) ?? pxValue(control.style.width);
        if (effectiveWidth !== null) {
          expect(effectiveWidth).toBeGreaterThanOrEqual(44);
        }
      }
    }

    it("nav + Bars claim control", async () => {
      setViewportWidth(390);
      const { container } = await renderLiveBoard();
      // Bars is the initial Region: its claim control is present.
      expect(
        screen.getByRole("button", { name: /claim this bar/i }),
      ).not.toBeNull();
      assertAllControlsTouchTarget(container);
    });

    it("Cards region play controls + the Card_Play_Wireframe dialog controls", async () => {
      setViewportWidth(390);
      const { container } = await renderLiveBoard();

      // Switch to the Cards region and confirm its play controls meet the target.
      fireEvent.click(screen.getByRole("button", { name: /^cards$/i }));
      const playButtons = await screen.findAllByRole("button", {
        name: /^play /i,
      });
      expect(playButtons.length).toBeGreaterThan(0);
      assertAllControlsTouchTarget(container);

      // Open the Card_Play_Wireframe for the first card and confirm its dialog
      // controls (target options + Confirm/Cancel) also meet the target.
      fireEvent.click(playButtons[0]);
      const dialog = await screen.findByRole("dialog", { name: /play card/i });
      expect(dialog).not.toBeNull();
      assertAllControlsTouchTarget(container);
    });
  });

  // R9.5: an active Targeted_Notification leaves the Region nav present and
  // operable. We seed a `wireframe_card_played` event targeting the current
  // Team so the page folds and renders a TargetedNotification, then assert the
  // nav still works.
  describe("an active Targeted_Notification leaves the Region nav operable (R9.5)", () => {
    it("renders the notification and keeps the three nav controls present and operable", async () => {
      setViewportWidth(390);
      // The current player (player-1, the seeded Player fact) must resolve to a
      // Team so the notice filter (R7.3) surfaces a notice for it. The lobby
      // reducer sets a player's Team from a `team_changed` event (a bare
      // `player_joined` leaves teamId null), so we add: player-1 joins, then is
      // placed on team-b, then team-a casts a targeting card at team-b — a
      // notice aimed at our Team.
      snapshotEvents = [
        ...liveSnapshot(GAME_ID),
        {
          id: `evt-${GAME_ID}-4`,
          gameId: GAME_ID,
          seq: 4,
          eventType: "player_joined",
          actorKind: "team",
          actorTeamId: null,
          payload: { playerId: "player-1", displayName: "Me" },
          createdAt: "2024-01-01T00:00:03.000Z",
        },
        {
          id: `evt-${GAME_ID}-5`,
          gameId: GAME_ID,
          seq: 5,
          eventType: "team_changed",
          actorKind: "team",
          actorTeamId: "team-b",
          payload: {
            playerId: "player-1",
            fromTeamId: null,
            toTeamId: "team-b",
          },
          createdAt: "2024-01-01T00:00:04.000Z",
        },
        {
          id: `evt-${GAME_ID}-6`,
          gameId: GAME_ID,
          seq: 6,
          eventType: "wireframe_card_played",
          actorKind: "team",
          actorTeamId: "team-a",
          payload: {
            castingTeamId: "team-a",
            targetTeamId: "team-b",
            cardId: "card-1",
          },
          createdAt: "2024-01-01T00:00:05.000Z",
        },
      ];

      const { container } = await renderLiveBoard();

      // The Targeted_Notification is present (its dismiss control is a stable
      // marker) — an active notification (R9.5).
      const dismiss = await screen.findByRole("button", {
        name: /dismiss notification/i,
      });
      expect(dismiss).not.toBeNull();
      // The dismiss control also meets the ≥44px touch target (R9.3).
      expect(pxValue(dismiss.style.minHeight)).toBeGreaterThanOrEqual(44);
      expect(pxValue(dismiss.style.minWidth)).toBeGreaterThanOrEqual(44);

      // With the notification active, the Region nav is STILL present with all
      // three controls (never obscured by the inline, non-modal banner) (R9.5).
      const nav = within(container).getByRole("navigation", {
        name: /game board regions/i,
      });
      const navButtons = within(nav).getAllByRole("button");
      expect(navButtons.length).toBe(3);

      // And it is operable: activating a non-active Region control switches the
      // active Region (Scoreboard becomes visible), proving the notification
      // blocks nothing (R9.5).
      fireEvent.click(within(nav).getByRole("button", { name: /scoreboard/i }));
      expect(
        await screen.findByRole("region", { name: /^scoreboard$/i }),
      ).not.toBeNull();
      // The notification is still present after navigating (it is not tied to a
      // Region), confirming it coexists with an operable nav.
      expect(
        screen.getByRole("button", { name: /dismiss notification/i }),
      ).not.toBeNull();
    });
  });

  // Viewport-independent: the html/body overflow-x guard that keeps the whole
  // page within the viewport lives in globals.css, which jsdom does not apply to
  // layout. Assert its presence directly (mirrors the lobby viewport test).
  describe("global overflow guards are present (R9.1)", () => {
    it("guards html/body against horizontal overflow", () => {
      expect(GLOBALS_CSS).toMatch(/overflow-x:\s*hidden/);
      expect(GLOBALS_CSS).toMatch(/max-width:\s*100%/);
    });

    it("applies a universal border-box box model", () => {
      expect(GLOBALS_CSS).toMatch(/box-sizing:\s*border-box/);
    });
  });
});
