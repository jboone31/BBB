// @vitest-environment jsdom
//
// Interaction tests for the LobbyRoster copy affordances (Task 5.2;
// Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7).
//
// These cover the share surface LobbyRoster owns as a client component: the
// Join_Code text, the browser-origin-derived Share_Link, and the two
// copy-to-clipboard controls. They complement the render/live-update tests in
// LobbyRoster.test.tsx by driving the clipboard side of the component:
//
//   R5.1 — the Join_Code renders as visible text.
//   R5.3 — on the client (jsdom has an origin), the Share_Link begins with
//          `window.location.origin` and embeds `?code={code}`.
//   R5.4 — when there is no known Join_Code, the share controls are omitted and
//          the component still renders without throwing.
//   R5.5 — activating the code copy control copies the raw Join_Code.
//   R5.6 — activating the link copy control copies the built Share_Link.
//   R5.7 — after either copy, the Join_Code text remains visible.
//
// APPROACH — spy the one impure edge, drive the real component:
//   `navigator.clipboard.writeText` is stubbed with a spy (via `vi.stubGlobal`)
//   so we can assert exactly what text each control copies without touching a
//   real clipboard. The component's `copyToClipboard` prefers this async API,
//   so the spy captures the copied value on click. `@vitest-environment jsdom`
//   opts this file into a DOM (the project default is `node`, see
//   vitest.config.mts); jsdom always exposes a `window`, so the null-origin
//   (SSR) branch is covered indirectly by rendering with a null Join_Code —
//   the only path that omits the share controls in a DOM environment. The pure
//   null-origin `buildShareLink` behavior is covered by task 1.2.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LobbyPlayerView, LobbyTeamView } from "@/lib/lobby/events";

import LobbyRoster from "./LobbyRoster";

const GAME_ID = "game-abc";
const JOIN_CODE = "ABCD12";

/** No teams/players are needed to exercise the share controls. */
const NO_TEAMS: readonly LobbyTeamView[] = [];
const NO_PLAYERS: readonly LobbyPlayerView[] = [];

/** A clipboard spy captured across each test. */
let writeText: ReturnType<typeof vi.fn>;

/** Render the roster with a known Join_Code (share controls present). */
function renderWithCode() {
  return render(
    <LobbyRoster
      gameId={GAME_ID}
      joinCode={JOIN_CODE}
      teams={NO_TEAMS}
      players={NO_PLAYERS}
    />,
  );
}

/** The two copy controls, addressed by their accessible names. */
function copyCodeButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /copy join code/i,
  }) as HTMLButtonElement;
}
function copyLinkButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /copy share link/i,
  }) as HTMLButtonElement;
}

beforeEach(() => {
  // Stub the async Clipboard API the component prefers. `writeText` resolves so
  // the "Copied" confirmation path runs; we only assert on the copied value.
  writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LobbyRoster shows the Join_Code and Share_Link (R5.1, R5.3)", () => {
  it("renders the Join_Code as visible text (R5.1)", () => {
    renderWithCode();
    expect(screen.getByText(JOIN_CODE)).not.toBeNull();
  });

  it("renders a Share_Link that begins with the browser origin and embeds ?code (R5.3)", () => {
    renderWithCode();

    // The rendered link is the absolute Share_Link built from window.location.origin.
    const link = screen.getByRole("link", {
      name: new RegExp(
        window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    }) as HTMLAnchorElement;

    expect(link.getAttribute("href")).toBe(
      `${window.location.origin}/games/${GAME_ID}/lobby?code=${JOIN_CODE}`,
    );
    // Begins with the current origin and carries the code query param.
    expect(link.getAttribute("href")?.startsWith(window.location.origin)).toBe(
      true,
    );
    expect(link.getAttribute("href")).toContain(`?code=${JOIN_CODE}`);
  });
});

describe("LobbyRoster copy controls copy the right text (R5.5, R5.6, R5.7)", () => {
  it("copies the raw Join_Code when the code copy control is activated (R5.5)", async () => {
    renderWithCode();

    fireEvent.click(copyCodeButton());

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    // The RAW Join_Code is copied, not the link.
    expect(writeText).toHaveBeenCalledWith(JOIN_CODE);

    // The Join_Code text survives the copy (R5.7).
    expect(screen.getByText(JOIN_CODE)).not.toBeNull();
  });

  it("copies the built Share_Link when the link copy control is activated (R5.6)", async () => {
    renderWithCode();

    fireEvent.click(copyLinkButton());

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    // The absolute Share_Link is copied verbatim.
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/games/${GAME_ID}/lobby?code=${JOIN_CODE}`,
    );

    // The Join_Code text survives the copy (R5.7).
    expect(screen.getByText(JOIN_CODE)).not.toBeNull();
  });
});

describe("LobbyRoster omits share controls with no known Join_Code (R5.4)", () => {
  it("renders without throwing and shows no copy controls when joinCode is null", () => {
    // With no known code the share region (and its absolute link) are omitted,
    // mirroring the SSR/null-origin path where the link cannot be built. jsdom
    // always has a window, so a null Join_Code is the DOM-reachable omission.
    expect(() =>
      render(
        <LobbyRoster
          gameId={GAME_ID}
          joinCode={null}
          teams={NO_TEAMS}
          players={NO_PLAYERS}
        />,
      ),
    ).not.toThrow();

    // No copy controls and no share link are present.
    expect(
      screen.queryByRole("button", { name: /copy join code/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /copy share link/i }),
    ).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();

    // The roster still renders its heading (no throw).
    expect(screen.getByRole("heading", { name: /^lobby$/i })).not.toBeNull();
  });
});
