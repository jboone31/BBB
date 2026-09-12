# BBB Web App — Feature Roadmap

A macro-level task list for the Beltline Bar Brawl web application (phase 3). Each item is
sized to be roughly one spec session. Order reflects dependencies: earlier features unblock
later ones. This is a living document — reorder, split, or merge items as the app takes shape.

For product vision see `.kiro/steering/product.md`, for the finalized ruleset see
`.kiro/steering/game-rules.md`, and for the card catalog see `.kiro/steering/cards.md`.

## Legend

- `[ ]` not started · `[~]` in progress · `[x]` done
- **Depends on:** features that should land first.
- **Backend (`Bn.n`)** features build server/domain/data + realtime logic and their own
  DB-backed tests, but do not need to be reachable from the app's UI.
- **UI wiring (`Un.n`)** features are the incremental interface pass for the backend feature
  they follow: they add the pages/navigation/entry points that make that backend feature
  usable end to end from the browser, and are done in their own spec **after** the backend
  feature lands. This split keeps each backend feature testable in isolation while ensuring
  that by the end of the roadmap every backend capability is wired into a fully functional
  application.

---

## 0. Foundation & Decisions

- [x] **F0.1 — Stack & hosting decision.** Lock the backend/hosting choice: Vercel +
  Supabase vs. the AWS alternative (with cost estimate). Resolves open items in
  `tech.md`. Blocks most build work.
  - Depends on: nothing.
  - _Done via the `web-app-foundation` spec. Decision recorded in
    `docs/decisions/0001-hosting-and-stack.md` (Vercel + Supabase, locked)._
- [x] **F0.2 — Project scaffold.** Initialize the Node.js app (framework choice), repo
  structure, linting/formatting, environment config, and a deployable "hello world."
  Updates `structure.md` with the real layout.
  - Depends on: F0.1.
  - _Done via the `web-app-foundation` spec. Next.js (App Router) + TypeScript, ESLint +
    Prettier, Vitest + fast-check, `.env.example`, and a mobile-first baseline page.
    `structure.md` reflects the real layout._
- [x] **F0.3 — Data model & real-time backbone.** Core schema (games, teams, players, bars,
  claims, cards, card plays, events) and the real-time propagation mechanism (e.g., Supabase
  subscriptions) that every live feature relies on. Directly targets the v0 latency problem.
  - Depends on: F0.1, F0.2.
  - _Done via the `web-app-foundation` spec. Migrations `0001`–`0007` (schema, claims,
    append-only `game_events`, cards + catalog seed, RLS, auto-timeout sweep), the
    `appendEvent` backbone, and the Supabase Realtime subscription client (`lib/realtime`)._
  - **Backend activation (remaining to go live):** populate the environment variables
    (`.env.local` locally; Vercel Preview/Production env for deploys — see `.env.example`),
    apply migrations `0001`–`0007` to the Supabase project, and enable Realtime on the
    `game_events` table. This connects the built backbone to a live Supabase instance.

- [ ] **U0.1 — App shell, navigation & entry points.** The app's UI skeleton that every later
  feature plugs into: replace the foundation "baseline is running" splash with a real
  mobile-first landing page, app-wide layout/navigation, and the entry points into a game.
  This is the home for the decisions the `game-setup-lobby` spec deliberately left out of
  scope:
  - **Host entry:** a link/flow that reaches the create-game surface (`/games/new/lobby`).
  - **Join-by-code / link entry:** decide the model — a share **link** that carries the game
    id (`/games/{id}/lobby`, matching what the join route already assumes) vs. a bare **code**
    a player types. If bare codes are supported, this feature owns the new
    `code → gameId` resolution route and its security posture (enumeration/info-leak surface,
    rate limiting, RLS). The `game-setup-lobby` join route (`POST /api/games/{gameId}/join`)
    already validates a submitted code **against a known game id**; the missing piece is how a
    player who only has a code arrives at the right game.
  - Depends on: F1.x (uses the lobby pages/components those features built).
  - _Rationale: `game-setup-lobby` built the lobby pages/components and the six routes, but no
    landing page or join-by-code entry (out of that spec's scope). Without this, the lobby is
    only reachable by typing a URL by hand._

## 1. Game Setup & Lobby

- [x] **F1.1 — Create/host a game (admin).** Admin creates a game and sets the **start bar**
  and **finish bar** locations. Produces a joinable game with a code/link.
  - Depends on: F0.3.
  - _Done via the `game-setup-lobby` spec (create route, bar designation, Join_Code
    generation) with DB-backed integration tests. UI reachability is handled by U0.1._
- [x] **F1.2 — Join a game & team selection (players).** Players join via code/link and are
  prompted to join a team; if slots remain (2–4 teams), they may create a team instead.
  Teams have colors.
  - Depends on: F1.1.
  - _Done via the `game-setup-lobby` spec (join route with teamless-player support, team
    create/select routes, colored teams, migration 0008). The **join-by-code entry point**
    (how a player who only has a code reaches the game) is deferred to U0.1._
- [x] **F1.3 — Start the game (admin).** Admin starts the game once teams are set;
  transitions state from lobby to live and unlocks claiming.
  - Depends on: F1.2.
  - _Done via the `game-setup-lobby` spec (start route, 2–4 team gate, teamless exclusion,
    `lobby → live` transition, `game_started` event)._

- [ ] **U1.1 — Lobby experience polish.** After U0.1 makes the lobby reachable, refine the
  end-to-end lobby clickthrough: host create + bar designation flow, join + team selection,
  the live roster, and the start control — including error states, share-the-code affordance,
  and the `live` handoff. Verified against the live backend in a real browser (the pieces
  `game-setup-lobby` could only cover with component/viewport tests).
  - Depends on: F1.3, U0.1.

## 2. Bars & Claiming

- [ ] **F2.1 — Bar selection & discovery.** How players pick bars: map API vs. predetermined
  list (open decision in `tech.md`). If list-based, include the **propose-a-bar** flow where
  players suggest missing bars for admin approval/denial.
  - Depends on: F1.3.
- [ ] **F2.2 — Claim a bar & scoring.** A team claims a bar once **at least half** its members
  finish a drink and taps "claim." Apply v1 scoring: start bar = 0; other bars split 12 among
  current claimers (12/6/4/3); finish bar awards 12 solo and **ends the game**. Recompute
  shares live as new teams claim.
  - Depends on: F2.1, F0.3.
- [ ] **F2.3 — Claim visualization.** Show which teams have claimed which bars, colored by all
  claiming teams' colors (map API, in-house map with hard-coded coordinates, or list — open
  decision). Live scoreboard.
  - Depends on: F2.2.

- [ ] **U2.1 — Bars, claiming & scoreboard UI.** Wire the F2 backend into the app: bar
  selection/discovery surface (and propose-a-bar flow if list-based), the claim action
  (half-team + "claim" tap), and the live claim visualization + scoreboard — all propagating
  in real time. Reachable from the in-game view established by U1.1.
  - Depends on: F2.3, U1.1.

## 3. Cards

- [ ] **F3.1 — Card draw & hand management.** On claiming a bar (incl. start), draw two and
  keep one. Enforce hand-size limits; if the hand is full, prompt to play a card before adding.
  - Depends on: F2.2.
- [ ] **F3.2 — Playing cards & targeting.** Play a card; if it targets a team, the caster
  chooses the target, who is **notified immediately** and **blocked from claiming** until
  conditions are met. Real-time delivery is the whole point (fixes v0 latency).
  - Depends on: F3.1, F0.3.
- [ ] **F3.3 — Card validation & photo feed.** Per-card completion checks (photo upload,
  location, timers). Photos are stored **temporarily** and posted to a **public feed** for all
  teams. Admin can **challenge** a completion, resetting the conditions.
  - Depends on: F3.2.
- [ ] **F3.4 — Card catalog implementation.** Encode each finalized v1 card's effect, casting
  cost, and validation logic (see `cards.md`), including economy/boost effects (Insured, Happy
  Hour, Power Hour, Party Crasher, Patient Investor, Window Shopping) and their interactions.
  - Depends on: F3.3.

- [ ] **U3.1 — Cards & photo-feed UI.** Wire the F3 backend into the app: the hand + draw/keep
  interaction, playing/targeting cards with immediate notification of the targeted team, the
  per-card validation surface (photo upload, timers, location), the public photo feed, and the
  admin challenge control. Real-time delivery is central here.
  - Depends on: F3.4, U2.1.

## 4. Endgame & Polish

- [ ] **F4.1 — Game end & winner.** Claiming the finish bar ends the game immediately; declare
  the team with the most points the winner. Final results screen.
  - Depends on: F2.2, F3.4.
- [ ] **F4.2 — Admin controls & moderation.** Consolidated admin tooling: challenges, disputes,
  removing players, pausing/ending a game, edge-case overrides.
  - Depends on: F3.3, F4.1.
- [ ] **F4.3 — Polish & branding.** Apply BBB branding (logo in `v0/BBB_logo.PNG`), responsive
  mobile-first UI, error states, and onboarding.
  - Depends on: core loop complete.

- [ ] **U4.1 — Endgame, admin & final polish UI.** Wire the F4 backend into the app: the
  game-end/winner results screen, the consolidated admin/moderation surface, and the final
  branding/onboarding/error-state pass across the whole app so the end-to-end experience is
  complete and cohesive.
  - Depends on: F4.3, U3.1.

---

## Cross-Cutting Concerns

These aren't standalone specs; fold them into the features above.

- **Real-time propagation** — every live feature (claims, scores, card plays, notifications,
  feed) must update all clients in near real time. This is the primary v0 problem to solve.
- **Mobile-first** — players use phones while walking the Beltline.
- **Auth & identity** — how players/admin are identified (accounts vs. lightweight session);
  decided in F0.3 / F1.x as session-based identity (`x-bbb-session-id`).
- **Photo lifecycle & privacy** — temporary storage, retention, and takedown for feed photos.
- **UI wiring cadence** — backend features (`Fn.n`) land with their own DB-backed tests but
  need not be reachable from the UI; a dedicated UI-wiring spec (`Un.n`) then makes each newly
  built capability usable end to end. Following this cadence, the roadmap ends with a fully
  functional, fully wired application.

---

_Living document. Update statuses and reorder as specs are completed._
