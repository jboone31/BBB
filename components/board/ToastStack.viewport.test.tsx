// @vitest-environment jsdom
//
// Viewport tests for the card-behavior Toast_Stack (card-behavior Task 10.8).
//
// Requirement 24.5: THE Board_UI SHALL render the new toasts, prompts, and
// actions at the existing 320px and desktop viewport bands without clipping,
// operable by keyboard and touch.
//
// JSDOM LAYOUT LIMITATION (same as the repo's other *.viewport.test.tsx files):
//   jsdom performs no layout, so real overflow cannot be measured. These tests
//   assert what IS checkable in jsdom at each band:
//     1. Every toast kind (actionable alert, Fairest prompt, dismissable status,
//        collapsed others' dropdown) renders and its content is present, so
//        nothing is clipped out of existence.
//     2. The overflow guards are wired: fluid `width/maxWidth: 100%` +
//        `box-sizing: border-box` on the stack and each toast, a wrapping action
//        row, `overflow-wrap: anywhere` on long text, and no inline px width
//        wider than the viewport.
//     3. Every interactive control (buttons, the dropdown summary) declares a
//        ≥44px touch target.
//     4. Keyboard operability: the first enabled action receives focus on
//        appearance, Tab reaches every action, and Enter / Space activate them
//        (native <button>/<summary> semantics, driven through user-event).

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FairestOfferRecord } from "@/lib/cards/behaviorState";
import type { Toast } from "@/lib/cards/toasts";
import type { BoardTeamView } from "@/lib/gameboard/events";

import ToastStack, { MIRROR_NO_LONGER_LEGAL } from "./ToastStack";

/** The narrow small-phone floor and two representative desktop widths. */
const BANDS = [320, 1024, 1440] as const;

const GAME = "game-vp";

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: "Team Bravo", color: "#00f" },
];

// A deliberately long, unbroken headline: without `overflow-wrap: anywhere` it
// would push a 320px toast wider than the viewport.
const LONG_WORD = "Supercalifragilisticexpialidocious".repeat(4);

const PIONEER_OFFER: FairestOfferRecord = {
  offerId: "offer-1",
  sourcePlayId: "play-2",
  slug: "pioneer",
  holderTeamId: "team-b",
  originalCasterTeamId: "team-a",
  challengeId: null,
  restrictionEffectId: "effect-1",
  status: "pending",
  decidedAt: null,
  mirroredChallengeId: null,
  mirroredEffectId: null,
};

function toasts(): Toast[] {
  return [
    {
      id: "1:target:play-1",
      kind: "target",
      seq: 1,
      headline: `Team Alpha has played WIRED on you! ${LONG_WORD}`,
      body: "Order a shot of espresso from a location that is not a bar.",
      dropdown: null,
      actions: [
        { kind: "mark_complete", challengeId: "challenge-1" },
        { kind: "we_failed", challengeId: "challenge-1" },
      ],
      dismissable: false,
    },
    {
      id: "2:fairest_prompt:offer-1",
      kind: "fairest_prompt",
      seq: 2,
      headline: "Play Fairest of Them All?",
      body: null,
      dropdown: null,
      actions: [
        { kind: "fairest_play", offerId: "offer-1" },
        { kind: "fairest_decline", offerId: "offer-1" },
      ],
      dismissable: false,
    },
    {
      id: "3:caster:play-3",
      kind: "caster",
      seq: 3,
      headline: "You played INSURANCE.",
      body: null,
      dropdown: "Your next claimed bar's points are protected.",
      actions: [],
      dismissable: true,
    },
    {
      id: "4:others:play-4",
      kind: "others",
      seq: 4,
      headline: "Team Alpha played a card!",
      body: null,
      dropdown: "The effect text.",
      actions: [],
      dismissable: false,
    },
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

function renderStack(
  overrides: Partial<React.ComponentProps<typeof ToastStack>> = {},
) {
  const postAction = vi.fn(async () => ({ applied: true }));
  const onDismiss = vi.fn();
  const result = render(
    <ToastStack
      gameId={GAME}
      toasts={toasts()}
      teams={TEAMS}
      offers={{ "offer-1": PIONEER_OFFER }}
      isMirrorLegal={() => true}
      postAction={postAction}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { ...result, postAction, onDismiss };
}

afterEach(cleanup);

describe("ToastStack viewport bands (Requirement 24.5)", () => {
  describe.each(BANDS)("at %dpx wide", (width) => {
    it("renders every toast kind with its content present", () => {
      setViewportWidth(width);
      renderStack();

      // Actionable target toast (alert) with both challenge actions.
      const target = screen.getByRole("alert", {
        name: /played wired on you/i,
      });
      expect(
        within(target).getByRole("button", { name: /mark complete/i }),
      ).toBeTruthy();
      expect(
        within(target).getByRole("button", { name: /we failed/i }),
      ).toBeTruthy();
      // Fairest prompt with Play / Decline.
      const prompt = screen.getByRole("alert", {
        name: /fairest of them all/i,
      });
      expect(
        within(prompt).getByRole("button", { name: /^play$/i }),
      ).toBeTruthy();
      expect(
        within(prompt).getByRole("button", { name: /decline/i }),
      ).toBeTruthy();
      // Dismissable status toast with its Details disclosure + Dismiss.
      const status = screen.getByRole("status", { name: /played insurance/i });
      expect(within(status).getByText("Details")).toBeTruthy();
      expect(
        within(status).getByRole("button", { name: /dismiss notification/i }),
      ).toBeTruthy();
      // Others' updates collapse into the dropdown.
      expect(screen.getByText(/other updates \(1\)/i)).toBeTruthy();
    });

    it("wires the no-clipping guards on the stack, each toast, and the action rows", () => {
      setViewportWidth(width);
      const { container } = renderStack();

      const stack = container.querySelector<HTMLElement>(
        '[aria-label="Card notifications"]',
      );
      expect(stack).not.toBeNull();
      expect(stack?.style.flexDirection).toBe("column");
      expect(stack?.style.maxWidth).toBe("100%");
      expect(stack?.style.boxSizing).toBe("border-box");

      const cards = container.querySelectorAll<HTMLElement>(
        '[aria-label="Card notifications"] > section',
      );
      expect(cards.length).toBe(3);
      for (const card of cards) {
        expect(card.style.width).toBe("100%");
        expect(card.style.maxWidth).toBe("100%");
        expect(card.style.boxSizing).toBe("border-box");
      }

      // Action rows wrap rather than overflow at 320px.
      for (const button of screen.getAllByRole("button", {
        name: /mark complete|^play$/i,
      })) {
        const row = button.parentElement as HTMLElement;
        expect(row.style.flexWrap).toBe("wrap");
      }

      // The long unbroken headline is allowed to break anywhere.
      const headline = screen.getByText(new RegExp(LONG_WORD));
      expect(headline.style.overflowWrap).toBe("anywhere");

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

    it("gives every button and disclosure summary a ≥44px touch target", () => {
      setViewportWidth(width);
      const { container } = renderStack();

      const controls =
        container.querySelectorAll<HTMLElement>("button, summary");
      // 2 target actions + 2 Fairest actions + Dismiss + 2 summaries.
      expect(controls.length).toBe(7);
      for (const control of controls) {
        const h = pxValue(control.style.minHeight);
        expect(h).not.toBeNull();
        expect(h as number).toBeGreaterThanOrEqual(44);
        const w = pxValue(control.style.minWidth);
        if (w !== null) {
          expect(w).toBeGreaterThanOrEqual(44);
        }
      }
    });

    it("is operable by keyboard: Tab reaches every action and Enter/Space activate them", async () => {
      setViewportWidth(width);
      const user = userEvent.setup();
      const { postAction, onDismiss } = renderStack();

      const markComplete = screen.getByRole("button", {
        name: /mark complete/i,
      });
      const weFailed = screen.getByRole("button", { name: /we failed/i });
      const play = screen.getByRole("button", { name: /^play$/i });
      const decline = screen.getByRole("button", { name: /decline/i });
      const dismiss = screen.getByRole("button", {
        name: /dismiss notification/i,
      });

      // Walk the tab order from the top of the document; every action is a
      // reachable tab stop.
      (document.activeElement as HTMLElement | null)?.blur();
      const reached = new Set<Element>();
      for (let i = 0; i < 10; i += 1) {
        await user.tab();
        if (document.activeElement !== null) {
          reached.add(document.activeElement);
        }
      }
      for (const control of [markComplete, weFailed, play, decline, dismiss]) {
        expect(reached.has(control)).toBe(true);
      }

      // Enter activates a challenge action, Space activates Decline.
      markComplete.focus();
      await user.keyboard("{Enter}");
      expect(postAction).toHaveBeenCalledWith(
        { kind: "mark_complete", challengeId: "challenge-1" },
        GAME,
      );
      decline.focus();
      await user.keyboard(" ");
      expect(postAction).toHaveBeenCalledWith(
        { kind: "fairest_decline", offerId: "offer-1" },
        GAME,
      );
      dismiss.focus();
      await user.keyboard("{Enter}");
      expect(onDismiss).toHaveBeenCalledWith("3:caster:play-3");
    });

    it("uses a native details/summary disclosure for the others' dropdown", async () => {
      // Browsers make a details' first-child <summary> a tab stop that toggles
      // on Enter/Space; jsdom models the toggle (activation) but not the key
      // binding, so assert the native structure plus the activation behavior.
      setViewportWidth(width);
      const user = userEvent.setup();
      const { container } = renderStack({
        toasts: toasts().filter((t) => t.kind === "others"),
      });
      const details = container.querySelector("details") as HTMLDetailsElement;
      const summary = details.firstElementChild as HTMLElement;
      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.getAttribute("tabindex")).toBeNull();
      expect(details.open).toBe(false);
      await user.click(summary);
      expect(details.open).toBe(true);
    });

    it("moves focus to Decline and keeps the mirror notice visible when Play is illegal", () => {
      setViewportWidth(width);
      renderStack({
        toasts: toasts().filter((t) => t.kind === "fairest_prompt"),
        isMirrorLegal: () => false,
      });
      const play = screen.getByRole("button", {
        name: /^play$/i,
      }) as HTMLButtonElement;
      const decline = screen.getByRole("button", { name: /decline/i });
      expect(play.disabled).toBe(true);
      expect(document.activeElement).toBe(decline);
      const notice = screen.getByText(MIRROR_NO_LONGER_LEGAL("Team Alpha"));
      expect(notice.style.overflowWrap).toBe("anywhere");
    });
  });
});
