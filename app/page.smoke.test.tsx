// @vitest-environment jsdom
//
// Landing render test for the branded Landing_Page (Task 8.1;
// Requirements 2.1, 2.4, 3.2, 4.1).
//
// This file replaces the former Deployable_Baseline "baseline is running"
// splash smoke test. `app/page.tsx` is now the branded Landing_Page: a
// mobile-first server component that renders the two entry points, Host_Entry
// (a `<Link>` to `/games/new/lobby`) and Join_Entry (a client component with a
// code input + submit). This test asserts that render.
//
// WHY jsdom + a mocked router:
//   The Landing_Page renders `JoinEntry`, a `"use client"` component that calls
//   `next/navigation`'s `useRouter()` at render time. Outside a Next.js router
//   context `useRouter()` throws, so we mock `next/navigation` (the same shape
//   the JoinEntry interaction tests use) and opt this file into a DOM via the
//   `@vitest-environment jsdom` docblock directive on line 1. The project's
//   default Vitest environment is `node`; this directive scopes the DOM to this
//   file only, leaving the global config untouched.
//
// WHAT this asserts:
//   R2.1 — requesting `/` renders the Host_Entry control and the Join_Entry area.
//   R3.2 — Host_Entry links to the create-game surface at `/games/new/lobby`.
//   R4.1 — Join_Entry renders a code text input and a submit control.
//   R2.4 — the foundation "baseline is running" splash content is gone.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// JoinEntry (rendered by the landing page) calls useRouter() at render time;
// mock next/navigation so it renders under jsdom without a router context.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import HomePage from "./page";

afterEach(() => {
  cleanup();
});

describe("Landing_Page renders the entry points (Requirements 2.1, 3.2, 4.1)", () => {
  it("renders the Host_Entry control linking to /games/new/lobby (R2.1, R3.2)", () => {
    render(<HomePage />);

    // Host_Entry is a Next.js <Link role="button"> labeled to indicate hosting.
    const host = screen.getByRole("button", { name: /host a game/i });
    // R3.2: it navigates to the existing create-game surface.
    expect(host.getAttribute("href")).toBe("/games/new/lobby");
  });

  it("renders the Join_Entry code input and submit control (R2.1, R4.1)", () => {
    render(<HomePage />);

    // R4.1: a text input for the Join_Code…
    expect(screen.getByRole("textbox", { name: /join code/i })).not.toBeNull();
    // …and a submit control.
    expect(screen.getByRole("button", { name: /join game/i })).not.toBeNull();
  });
});

describe("Landing_Page replaces the foundation splash (Requirement 2.4)", () => {
  it("no longer renders the 'baseline is running' splash content", () => {
    const { container } = render(<HomePage />);

    // R2.4: the foundation splash copy and its status region are gone.
    expect(container.textContent ?? "").not.toMatch(/baseline is running/i);
    expect(container.textContent ?? "").not.toMatch(/running/i);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector(".baseline")).toBeNull();
  });
});
