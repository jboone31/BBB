"use client";

/**
 * Real-time propagation demo route (design.md Component 7; Task 16.2; Req 6.10).
 *
 * Reachable at `/demo`, this page hosts the F0.3 demonstration: it renders
 * {@link PropagationDemo}, which subscribes to a game's `Real_Time_Channel` and
 * shows events as they arrive, plus a control to POST the demo mutation
 * (`/api/demo-mutation`) that persists one `Game_State_Change`.
 *
 * How the demonstration works: open `/demo` on two devices/tabs, enter the same
 * game id and a session id that is a member of that game, then trigger a state
 * change on one and watch the corresponding event land on the other in near real
 * time (Req 6.10).
 *
 * The game id and session id are collected from small inputs (and seeded from
 * `?gameId=&sessionId=` query params) rather than hard-coded, so the demo works
 * against any game without a rebuild. The page is mobile-first and fits 320–375px
 * viewports with no horizontal scroll (Req 2.11 spirit).
 *
 * This is its own route so it does not touch the baseline `app/page.tsx`
 * (Task 16.1).
 */

import { useState } from "react";

import PropagationDemo from "@/components/PropagationDemo";

/** Read an initial value from the URL query string (client-side only). */
function readQueryParam(name: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

export default function DemoPage(): React.JSX.Element {
  // Seed from the query string lazily on first client render, so a link can
  // prefill the demo (`?gameId=&sessionId=`). This route is client-rendered, so
  // reading `window` in the initializer is safe and avoids a setState-in-effect.
  const [gameId, setGameId] = useState<string>(() => readQueryParam("gameId"));
  const [sessionId, setSessionId] = useState<string>(() =>
    readQueryParam("sessionId"),
  );

  const trimmedGameId = gameId.trim();
  const trimmedSessionId = sessionId.trim();

  return (
    <main
      style={{
        maxWidth: "26rem",
        margin: "0 auto",
        padding: "1rem",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <header
        style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
      >
        <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Beltline Bar Brawl</h1>
        <p style={{ margin: 0, fontSize: "0.9rem", color: "#555" }}>
          End-to-end real-time propagation demo
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
      >
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}
        >
          <span style={{ fontSize: "0.8rem" }}>Game id</span>
          <input
            value={gameId}
            onChange={(e) => setGameId(e.target.value)}
            placeholder="game UUID"
            autoComplete="off"
            style={{
              padding: "0.5rem",
              fontSize: "0.9rem",
              borderRadius: "0.4rem",
              border: "1px solid #999",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}
        >
          <span style={{ fontSize: "0.8rem" }}>Session id</span>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="your session id (game member)"
            autoComplete="off"
            style={{
              padding: "0.5rem",
              fontSize: "0.9rem",
              borderRadius: "0.4rem",
              border: "1px solid #999",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
        </label>
      </form>

      <PropagationDemo
        gameId={trimmedGameId === "" ? undefined : trimmedGameId}
        sessionId={trimmedSessionId === "" ? undefined : trimmedSessionId}
      />
    </main>
  );
}
