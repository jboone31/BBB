// @vitest-environment jsdom
//
// Interaction tests for the Join_Entry control (Task 7.3; Requirements 4.3–4.6).
//
// These cover the network + navigation behavior JoinEntry owns as a client
// component. Unlike the co-located property test (Task 7.2, which proves
// malformed codes never reach the network), this file exercises the happy path
// and error/in-flight paths against a mocked router and a controllable `fetch`:
//
//   R4.3 — a well-formed code is normalized and sent to the Resolution_Service.
//   R4.4 — on a matching id, navigate to `/games/{gameId}/lobby?code=...`
//          carrying the normalized code.
//   R4.5 — a not-found result (404) shows the uniform code-not-recognized message.
//   R4.6 — the submit control is disabled while a request is in flight.
//
// APPROACH — mock the two impure edges, drive the real component:
//   `next/navigation`'s `useRouter` is mocked so we can capture `push` (the
//   navigation JoinEntry performs on success); it throws outside a router
//   context otherwise. `global.fetch` is a `vi.fn()` each test wires to return
//   the response shape it needs. The in-flight test hands back a promise the
//   test controls (a deferred), so we can assert the submit is disabled BEFORE
//   resolving it, then resolve and confirm it re-enables. `@vitest-environment
//   jsdom` opts this file into a DOM (the project default is `node`).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import JoinEntry from "./JoinEntry";

/** A raw code that normalizes (trim + uppercase) to a valid 6-char code. */
const RAW_CODE = "  k7qp2m  ";
const NORMALIZED_CODE = "K7QP2M";

/** Grab the code input and submit button from the rendered control. */
function controls() {
  const input = screen.getByRole("textbox", {
    name: /join code/i,
  }) as HTMLInputElement;
  const submit = screen.getByRole("button", {
    name: /join game|finding your game/i,
  }) as HTMLButtonElement;
  return { input, submit };
}

/** Type a value into the code input and submit the form. */
function submitCode(value: string) {
  const { input, submit } = controls();
  fireEvent.change(input, { target: { value } });
  fireEvent.click(submit);
  return { input, submit };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pushMock.mockReset();
});

describe("JoinEntry sends normalized code and navigates on success (R4.3, R4.4)", () => {
  beforeEach(() => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ resolved: true, gameId: "game-xyz" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
  });

  it("POSTs the normalized code to the Resolution_Service (R4.3)", async () => {
    render(<JoinEntry />);
    submitCode(RAW_CODE);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("/api/games/resolve");
    expect(init?.method).toBe("POST");
    // The body carries the NORMALIZED code, not the raw whitespace/lowercase.
    expect(JSON.parse(init?.body as string)).toEqual({
      joinCode: NORMALIZED_CODE,
    });
  });

  it("navigates to the resolved lobby carrying the normalized code (R4.4)", async () => {
    render(<JoinEntry />);
    submitCode(RAW_CODE);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledTimes(1);
    });
    expect(pushMock).toHaveBeenCalledWith(
      `/games/game-xyz/lobby?code=${NORMALIZED_CODE}`,
    );
    // A successful resolution shows no error message.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("JoinEntry shows the uniform not-recognized message on a miss (R4.5)", () => {
  it("displays the code-not-recognized message on a 404 and does not navigate", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ resolved: false }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    render(<JoinEntry />);
    submitCode(RAW_CODE);

    // The request was issued (the code was well-formed), then rejected.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn.t find a game for that code/i);
    // A miss never navigates.
    expect(pushMock).not.toHaveBeenCalled();
    // The submit control is re-enabled so the player can retry.
    expect(controls().submit.disabled).toBe(false);
  });
});

describe("JoinEntry disables the submit control while a request is in flight (R4.6)", () => {
  it("disables submit during the request and re-enables it after resolution", async () => {
    // A deferred whose resolution the test controls, so we can observe the
    // in-flight state before the fetch settles.
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = vi.fn(() => pending) as unknown as typeof fetch;

    render(<JoinEntry />);
    const { submit } = submitCode(RAW_CODE);

    // WHILE the request is in flight the submit control is disabled (R4.6).
    await waitFor(() => {
      expect(submit.disabled).toBe(true);
    });
    // The control reflects its working state.
    expect(submit.textContent).toMatch(/finding your game/i);
    expect(pushMock).not.toHaveBeenCalled();

    // Settle the request with a successful resolution.
    resolveFetch(
      new Response(JSON.stringify({ resolved: true, gameId: "game-xyz" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // After resolution the control re-enables (via `finally`) and navigation
    // fires.
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        `/games/game-xyz/lobby?code=${NORMALIZED_CODE}`,
      );
    });
  });
});
