// @vitest-environment jsdom
//
// Host_Card_Panel component tests (card-behavior Task 11.4; Requirements 21.8,
// 21.10, 21.11).
//
// The rows are built with the real `selectHostItems` selector over folded
// challenge / effect records, so the panel is tested against the actions the
// selector actually offers. Only the network poster is injected. The tests
// assert:
//   - every challenge shows card, target, and status with its valid action;
//   - pending/active effects show "End early", ended effects are omitted, and a
//     Pioneer / Scenic Route restriction is labeled with its team;
//   - an action opens a confirmation dialog and posts only on Confirm, with the
//     session id; Cancel / Escape post nothing and restore focus;
//   - a rejection is shown inline and the dialog stays open;
//   - the default poster hits the host routes with the session header.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChallengeRecord } from "@/lib/cards/behaviorState";
import type { EffectRecord } from "@/lib/cards/effects";
import { selectHostItems } from "@/lib/gameboard/cardBehavior";
import {
  initialCardBehaviorView,
  type BoardTeamView,
  type CardBehaviorView,
} from "@/lib/gameboard/events";

import HostCardPanel, {
  defaultPostHostOverride,
  type PostHostOverride,
} from "./HostCardPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GAME = "game-1";
const SESSION = "host-session";
const NOW = Date.parse("2025-06-01T20:00:00.000Z");
const iso = (offsetMs: number): string =>
  new Date(NOW + offsetMs).toISOString();

const TEAMS: BoardTeamView[] = [
  { id: "team-a", name: "Team Alpha", color: "#f00" },
  { id: "team-b", name: "Team Bravo", color: "#00f" },
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

function viewWith(
  challenges: ChallengeRecord[],
  effects: EffectRecord[],
): CardBehaviorView {
  return {
    ...initialCardBehaviorView(),
    challenges: Object.fromEntries(challenges.map((c) => [c.challengeId, c])),
    effects: Object.fromEntries(effects.map((e) => [e.effectId, e])),
  };
}

function renderPanel(
  view: CardBehaviorView,
  postOverride: PostHostOverride = vi.fn(async () => ({ applied: true })),
  sessionId: string | null = SESSION,
) {
  render(
    <HostCardPanel
      gameId={GAME}
      sessionId={sessionId}
      items={selectHostItems(view, NOW)}
      teams={TEAMS}
      postOverride={postOverride}
    />,
  );
  return { postOverride };
}

describe("HostCardPanel — rows", () => {
  it("lists each challenge with card, target, status, and its valid action", () => {
    renderPanel(
      viewWith(
        [
          challenge({ challengeId: "ch-1", status: "open" }),
          challenge({
            challengeId: "ch-2",
            slug: "dirty-bird",
            status: "completed",
          }),
          challenge({ challengeId: "ch-3", status: "cleared_by_host" }),
        ],
        [],
      ),
    );
    const list = screen.getByRole("list", { name: "Challenges" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(rows[0].textContent).toContain("Wired");
    expect(rows[0].textContent).toContain("Target: Team Bravo");
    expect(rows[0].textContent).toContain("Status: Open");
    expect(
      within(rows[0]).getByRole("button", {
        name: "Clear Wired on Team Bravo",
      }),
    ).toBeTruthy();

    expect(rows[1].textContent).toContain("Status: Completed");
    expect(
      within(rows[1]).getByRole("button", { name: /^Reset / }),
    ).toBeTruthy();

    // A host-cleared challenge is terminal: listed with no action.
    expect(rows[2].textContent).toContain("Status: Cleared by host");
    expect(within(rows[2]).queryByRole("button")).toBeNull();
  });

  it("offers End early on pending/active effects, omits ended ones, and labels restrictions with their team", () => {
    renderPanel(
      viewWith(
        [],
        [
          effect({ effectId: "ef-1" }),
          effect({
            effectId: "ef-2",
            slug: "pioneer",
            kind: "next_claim_restriction",
            targetTeamId: "team-b",
            endsAt: null,
            params: { rule: "pioneer" },
          }),
          effect({
            effectId: "ef-3",
            slug: "scenic-route",
            kind: "next_claim_restriction",
            targetTeamId: "team-a",
            endsAt: null,
            params: { rule: "scenic" },
          }),
          // Consumed restriction: nothing left to end.
          effect({
            effectId: "ef-4",
            slug: "pioneer",
            kind: "next_claim_restriction",
            targetTeamId: "team-a",
            endsAt: null,
            params: { rule: "pioneer" },
            consumedAt: iso(-1_000),
          }),
          // Pending Cancel Culture window.
          effect({
            effectId: "ef-5",
            slug: "cancel-culture",
            kind: "radius_lock",
            startsAt: iso(5 * 60_000),
            endsAt: iso(20 * 60_000),
            startAnnounced: false,
          }),
        ],
      ),
    );
    const list = screen.getByRole("list", { name: "Effects" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(
      screen.getByRole("button", {
        name: "End Pioneer restriction on Team Bravo early",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "End Scenic Route restriction on Team Alpha early",
      }),
    ).toBeTruthy();
    expect(rows[3].textContent).toContain("Pending");
    expect(screen.getAllByRole("button", { name: /early$/ })).toHaveLength(4);
  });

  it("shows empty states when there is nothing to override", () => {
    renderPanel(viewWith([], []));
    expect(screen.getByText("No challenges yet.")).toBeTruthy();
    expect(screen.getByText("No pending or active effects.")).toBeTruthy();
  });
});

describe("HostCardPanel — confirm before posting", () => {
  it("posts a challenge clear only after Confirm, with the session id", async () => {
    const { postOverride } = renderPanel(viewWith([challenge()], []));
    fireEvent.click(
      screen.getByRole("button", { name: "Clear Wired on Team Bravo" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Clear challenge?" });
    expect(postOverride).not.toHaveBeenCalled();
    // Focus moves into the dialog on the safe default.
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postOverride).toHaveBeenCalledWith(
      { kind: "challenge", challengeId: "ch-1", action: "clear" },
      GAME,
      SESSION,
    );
  });

  it("posts an effect end after Confirm", async () => {
    const { postOverride } = renderPanel(viewWith([], [effect()]));
    fireEvent.click(screen.getByRole("button", { name: /early$/ }));
    const dialog = screen.getByRole("dialog", { name: "End effect early?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "End early" }));
    await waitFor(() => expect(postOverride).toHaveBeenCalledTimes(1));
    expect(postOverride).toHaveBeenCalledWith(
      { kind: "effect", effectId: "ef-1", action: "end" },
      GAME,
      SESSION,
    );
  });

  it("Cancel and Escape close the dialog without posting and restore focus", () => {
    const { postOverride } = renderPanel(viewWith([challenge()], []));
    const opener = screen.getByRole("button", {
      name: "Clear Wired on Team Bravo",
    });

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(postOverride).not.toHaveBeenCalled();
  });

  it("shows a rejection inline and keeps the dialog open", async () => {
    const postOverride = vi.fn(async () => ({
      applied: false,
      error: "conflict",
    }));
    renderPanel(viewWith([challenge({ status: "failed" })], []), postOverride);
    fireEvent.click(screen.getByRole("button", { name: /^Reset / }));
    const dialog = screen.getByRole("dialog", { name: "Reset challenge?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "This override no longer applies",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not post without a session", () => {
    const { postOverride } = renderPanel(
      viewWith([challenge()], []),
      vi.fn(async () => ({ applied: true })),
      null,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear Wired on Team Bravo" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Your session is not ready yet",
    );
    expect(postOverride).not.toHaveBeenCalled();
  });
});

describe("defaultPostHostOverride", () => {
  it("posts to the host routes with the session header", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ applied: true, seq: 9 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultPostHostOverride(
      { kind: "challenge", challengeId: "ch-1", action: "reset" },
      GAME,
      SESSION,
    );
    const result = await defaultPostHostOverride(
      { kind: "effect", effectId: "ef-1", action: "end" },
      GAME,
      SESSION,
    );

    expect(result.applied).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/games/${GAME}/host/challenges/ch-1`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-bbb-session-id": SESSION }),
        body: JSON.stringify({ action: "reset" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/games/${GAME}/host/effects/ef-1`,
      expect.objectContaining({ body: JSON.stringify({ action: "end" }) }),
    );
  });
});
