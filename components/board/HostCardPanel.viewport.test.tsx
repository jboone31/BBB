// @vitest-environment jsdom
//
// Viewport tests for the Host_Card_Panel (card-behavior Task 11.5).
//
// Requirement 24.5: THE Board_UI SHALL render the new toasts, prompts, and
// actions at the existing 320px and desktop viewport bands without clipping,
// operable by keyboard and touch.
//
// JSDOM LAYOUT LIMITATION (same as the repo's other *.viewport.test.tsx files):
//   jsdom performs no layout, so real overflow cannot be measured. These tests
//   assert what IS checkable in jsdom at each band:
//     1. Every challenge and effect row (including a restriction labeled with
//        its team) renders with its actions present, so nothing is clipped out
//        of existence.
//     2. The overflow guards are wired: a fluid `width: 100%` +
//        `box-sizing: border-box` panel, wrapping rows, `overflow-wrap:
//        anywhere` on long row and dialog text, a fluid dialog card, and no
//        inline px width wider than the viewport.
//     3. Every button (row actions and the dialog's Cancel / Confirm) declares
//        a ≥44px touch target.
//     4. Keyboard operability: Tab reaches every row action, Enter / Space open
//        the confirmation dialog, focus lands on Cancel, Tab stays inside the
//        modal dialog, Escape closes it and restores focus, and Enter on
//        Confirm posts the override.
//
// Rows are built with the real `selectHostItems` selector, as in
// HostCardPanel.test.tsx; only the network poster is injected.

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChallengeRecord } from "@/lib/cards/behaviorState";
import type { EffectRecord } from "@/lib/cards/effects";
import { selectHostItems } from "@/lib/gameboard/cardBehavior";
import {
  initialCardBehaviorView,
  type BoardTeamView,
  type CardBehaviorView,
} from "@/lib/gameboard/events";

import HostCardPanel, { type PostHostOverride } from "./HostCardPanel";

/** The narrow small-phone floor and two representative desktop widths. */
const BANDS = [320, 1024, 1440] as const;

const GAME = "game-vp";
const SESSION = "host-session";
const NOW = Date.parse("2025-06-01T20:00:00.000Z");
const iso = (offsetMs: number): string =>
  new Date(NOW + offsetMs).toISOString();

// A deliberately long, unbroken team name: without `overflow-wrap: anywhere`
// it would push a 320px row (and the dialog text) wider than the viewport.
const LONG_NAME = "Supercalifragilisticexpialidocious".repeat(3);

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: LONG_NAME, color: "#00f" },
];

function challenge(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
  return {
    challengeId: "ch-1",
    slug: "wired",
    sourcePlayId: "play-1",
    casterTeamId: "team-a",
    targetTeamId: "team-b",
    params: { kind: "none" },
    mirroredFromChallengeId: null,
    mirroredFromPlayId: null,
    status: "open",
    createdAt: iso(-60_000),
    resolvedAt: null,
    resolvedByTeamId: null,
    resolvedBySessionId: null,
    resolvedByKind: null,
    failureEffectId: null,
    ...overrides,
  };
}

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    effectId: "ef-1",
    slug: "power-hour",
    kind: "draw_override",
    sourcePlayId: "play-2",
    sourceChallengeId: null,
    ownerTeamId: "team-a",
    targetTeamId: null,
    targetBarKey: null,
    startsAt: iso(-60_000),
    endsAt: iso(20 * 60_000),
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

/** One open challenge (Clear), one completed (Reset), Power Hour + Pioneer. */
function view(): CardBehaviorView {
  const challenges = [
    challenge({ challengeId: "ch-1", status: "open" }),
    challenge({
      challengeId: "ch-2",
      slug: "dirty-bird",
      status: "completed",
    }),
  ];
  const effects = [
    effect({ effectId: "ef-1" }),
    effect({
      effectId: "ef-2",
      slug: "pioneer",
      kind: "next_claim_restriction",
      targetTeamId: "team-b",
      endsAt: null,
      params: { rule: "pioneer" },
    }),
  ];
  return {
    ...initialCardBehaviorView(),
    challenges: Object.fromEntries(challenges.map((c) => [c.challengeId, c])),
    effects: Object.fromEntries(effects.map((e) => [e.effectId, e])),
  };
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

function renderPanel() {
  const postOverride = vi.fn<PostHostOverride>(async () => ({
    applied: true,
  }));
  const result = render(
    <HostCardPanel
      gameId={GAME}
      sessionId={SESSION}
      items={selectHostItems(view(), NOW)}
      teams={TEAMS}
      postOverride={postOverride}
    />,
  );
  return { ...result, postOverride };
}

function assertNoWidePxWidths(root: ParentNode, width: number): void {
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    for (const raw of [el.style.width, el.style.minWidth, el.style.maxWidth]) {
      const px = pxValue(raw);
      if (px !== null) {
        expect(px).toBeLessThanOrEqual(width);
      }
    }
  }
}

function assertTouchTargets(controls: Iterable<HTMLElement>): void {
  for (const control of controls) {
    const h = pxValue(control.style.minHeight);
    expect(h).not.toBeNull();
    expect(h as number).toBeGreaterThanOrEqual(44);
    const w = pxValue(control.style.minWidth);
    expect(w).not.toBeNull();
    expect(w as number).toBeGreaterThanOrEqual(44);
  }
}

const CLEAR_NAME = `Clear Wired on ${LONG_NAME}`;

afterEach(cleanup);

describe("HostCardPanel viewport bands (Requirement 24.5)", () => {
  describe.each(BANDS)("at %dpx wide", (width) => {
    it("renders every challenge and effect row with its actions present", () => {
      setViewportWidth(width);
      renderPanel();

      const challenges = screen.getByRole("list", { name: "Challenges" });
      expect(within(challenges).getAllByRole("listitem")).toHaveLength(2);
      expect(
        within(challenges).getByRole("button", { name: CLEAR_NAME }),
      ).toBeTruthy();
      expect(
        within(challenges).getByRole("button", { name: /^Reset / }),
      ).toBeTruthy();

      const effects = screen.getByRole("list", { name: "Effects" });
      expect(within(effects).getAllByRole("listitem")).toHaveLength(2);
      expect(
        within(effects).getByRole("button", {
          name: `End Pioneer restriction on ${LONG_NAME} early`,
        }),
      ).toBeTruthy();
      expect(
        within(effects).getAllByRole("button", { name: /early$/ }),
      ).toHaveLength(2);
    });

    it("wires the no-clipping guards on the panel, rows, and dialog", async () => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { container } = renderPanel();

      const panel = screen.getByRole("region", { name: "Host card controls" });
      expect(panel.style.width).toBe("100%");
      expect(panel.style.minWidth).toBe("0");
      expect(panel.style.boxSizing).toBe("border-box");

      for (const row of screen.getAllByRole("listitem")) {
        expect(row.style.flexWrap).toBe("wrap");
        expect(row.style.minWidth).toBe("0");
        const text = row.firstElementChild as HTMLElement;
        expect(text.style.overflowWrap).toBe("anywhere");
        expect(text.style.minWidth).toBe("0");
      }
      assertNoWidePxWidths(container, width);

      // The confirmation dialog card is fluid and breaks long names.
      await user.click(screen.getByRole("button", { name: CLEAR_NAME }));
      const dialog = screen.getByRole("dialog", { name: "Clear challenge?" });
      expect(dialog.style.position).toBe("fixed");
      const card = dialog.firstElementChild as HTMLElement;
      expect(card.style.width).toBe("100%");
      expect(card.style.boxSizing).toBe("border-box");
      expect(card.style.overflowWrap).toBe("anywhere");
      const actionRow = within(dialog).getByRole("button", { name: "Cancel" })
        .parentElement as HTMLElement;
      expect(actionRow.style.flexWrap).toBe("wrap");
      assertNoWidePxWidths(dialog, width);
    });

    it("gives every row action and dialog button a ≥44px touch target", async () => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { container } = renderPanel();

      const rowButtons = container.querySelectorAll<HTMLElement>("button");
      // Clear + Reset + two End early.
      expect(rowButtons.length).toBe(4);
      assertTouchTargets(rowButtons);

      await user.click(screen.getByRole("button", { name: CLEAR_NAME }));
      const dialogButtons = within(screen.getByRole("dialog")).getAllByRole(
        "button",
      );
      expect(dialogButtons).toHaveLength(2);
      assertTouchTargets(dialogButtons);
    });

    it("is operable by keyboard: Tab, Enter/Space, Escape, and Confirm", async () => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { postOverride } = renderPanel();

      const clear = screen.getByRole("button", { name: CLEAR_NAME });
      const reset = screen.getByRole("button", { name: /^Reset / });
      const ends = screen.getAllByRole("button", { name: /early$/ });

      // Every row action is a reachable tab stop.
      (document.activeElement as HTMLElement | null)?.blur();
      const reached = new Set<Element>();
      for (let i = 0; i < 6; i += 1) {
        await user.tab();
        if (document.activeElement !== null) {
          reached.add(document.activeElement);
        }
      }
      for (const control of [clear, reset, ...ends]) {
        expect(reached.has(control)).toBe(true);
      }

      // Enter opens the dialog; focus lands on Cancel (the safe default).
      clear.focus();
      await user.keyboard("{Enter}");
      let dialog = screen.getByRole("dialog", { name: "Clear challenge?" });
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      const confirm = within(dialog).getByRole("button", { name: "Clear" });
      expect(document.activeElement).toBe(cancel);

      // Tab / Shift+Tab stay inside the modal dialog.
      await user.tab();
      expect(document.activeElement).toBe(confirm);
      await user.tab();
      expect(document.activeElement).toBe(cancel);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(confirm);

      // Escape closes without posting and restores focus to the opener.
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(clear);
      expect(postOverride).not.toHaveBeenCalled();

      // Space opens the effect dialog; Enter on Confirm posts the override.
      ends[0].focus();
      await user.keyboard(" ");
      dialog = screen.getByRole("dialog", { name: "End effect early?" });
      within(dialog).getByRole("button", { name: "End early" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(postOverride).toHaveBeenCalledWith(
        { kind: "effect", effectId: "ef-1", action: "end" },
        GAME,
        SESSION,
      );
    });
  });
});
