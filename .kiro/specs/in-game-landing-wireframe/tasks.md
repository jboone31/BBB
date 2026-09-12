# Implementation Plan: In-Game Landing Wireframe

## Overview

This plan implements the In-Game Landing Wireframe (ROADMAP U1.x connective shell) by building
thin new code on top of the web-app-foundation and the game-setup-lobby backbone, exactly as
the design prescribes: a pure, framework-free reducer + placeholder model in `lib/gameboard/`,
one transactional server route under `app/api/games/[gameId]/wireframe-card-play/`, a set of
mobile-first presentational components under `components/board/`, the `Game_Board` page at
`app/games/[gameId]/board/page.tsx`, and the lobby→board navigation entry point on the existing
lobby page.

The approach is test-driven with **Vitest** + **fast-check**, mirroring the lobby feature. Each
of the design's ten correctness properties maps to a co-located `*.property.test.ts(x)` task
(≥100 iterations, tagged `Feature: in-game-landing-wireframe, Property N: ...`). The board reuses
`lib/realtime` (subscribe / applyInOrder / ReconnectController / ResumeController /
LocalStorageLastSeenStore / supabaseBrowser), `lib/session/supabaseSession`, `lib/events`,
`lib/db/server`, and `app/api/games/_shared` **unchanged** — those already-property-tested
mechanisms are referenced in place, not re-implemented. No schema change is required; the one
new event type (`wireframe_card_played`) rides the existing `game_events` table.

Tasks are ordered so each builds on the previous: pure reducer + model + access/region logic
first (unit- and property-testable in isolation), then the one server route that wraps
`withTransaction` + `appendEvent`, then the presentational components, then the board page that
subscribes and composes everything, then the lobby navigation entry point, then viewport and
integration coverage that wires it all together. There are no orphaned modules — every piece is
integrated by the board page composition step.

## Tasks

- [ ] 1. Scaffold `lib/gameboard/` module skeletons and shared types
  - Create `lib/gameboard/` directory with `events.ts`, `placeholderCards.ts`, `access.ts`, `region.ts` module skeletons
  - Define exported types/constants per design §Components 1–2 and §Data Models: `GAME_BOARD_EVENT_TYPES`, `GameBoardLifecycle`, `BoardTeamView`, `TargetedNotice`, `GameBoardView`, `PlaceholderCard`, and the `Region = "bars" | "scoreboard" | "cards"` union
  - Confirm reuse imports resolve: `GameEvent` from `lib/events`, and the realtime/session/db/_shared seams the board will later consume
  - _Requirements: 2.6, 8.4_

- [ ] 2. Implement the pure Game_Board reducer (`lib/gameboard/events.ts`)
  - [ ] 2.1 Implement `initialGameBoardView`, `applyGameBoardEvent`, `foldGameBoardEvents`, `dismissTargetedNotice`
    - `applyGameBoardEvent`: reject foreign `gameId`; ignore `seq <= lastSeenSequence` (idempotent); fold `game_created`/`team_created` into `teams` (id, name, color), `game_started` → lifecycle `live`, `game_ended` → lifecycle `ended`, `wireframe_card_played` → append one `TargetedNotice { seq, castingTeamId, targetTeamId, cardId }`; advance `lastSeenSequence` per applied event
    - `foldGameBoardEvents`: sort by `seq` ascending, reduce from `initialGameBoardView`
    - `dismissTargetedNotice`: remove exactly the notice whose producing event `seq` matches, leaving all others unchanged
    - _Requirements: 1.4, 4.1, 4.2, 7.5, 7.8, 8.2, 8.3, 8.4_
  - [ ]* 2.2 Write property test `lib/gameboard/events.property.test.ts` for canonical, idempotent, ordered fold
    - **Property 4: Canonical, idempotent, ordered fold**
    - **Validates: Requirements 8.2, 8.3**
  - [ ]* 2.3 Write property test in `lib/gameboard/events.property.test.ts` for own-game-only folding
    - **Property 5: The reducer only folds its own Game's events**
    - **Validates: Requirements 8.4**
  - [ ]* 2.4 Write property test in `lib/gameboard/notices.property.test.ts` for one-notice-per-targeting-event
    - **Property 9: Each targeting event yields exactly one notice naming its caster**
    - **Validates: Requirements 7.3, 7.8**
  - [ ]* 2.5 Write property test in `lib/gameboard/notices.property.test.ts` for dismissal removing exactly one notice
    - **Property 10: Dismissing removes exactly the named notice**
    - **Validates: Requirements 7.5**

- [ ] 3. Implement the placeholder card model (`lib/gameboard/placeholderCards.ts`)
  - [ ] 3.1 Implement `placeholderHand(playerId)` — deterministic, seeded by `playerId`, returning 1–8 `PlaceholderCard`s with distinct ids and a mix of `targetsTeam` true/false
    - _Requirements: 5.2, 6.2, 6.3_
  - [ ]* 3.2 Write property test `lib/gameboard/placeholderCards.property.test.ts` for bounded hand size and distinct ids
    - **Property 7: Placeholder hand size is bounded**
    - **Validates: Requirements 5.2**

- [ ] 4. Implement the board access decision helper (`lib/gameboard/access.ts`)
  - [ ] 4.1 Implement `selectBoardAccess(lifecycle, hasSession, isAdmin, isPlayer)` returning exactly one of `no-session | not-authorized | redirect-lobby | ended | board` per the design's access-gate table
    - Return `board` iff a valid Session is present, the Session is Admin or Player, and `lifecycle === "live"`; every other input yields a non-`board` decision
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_
  - [ ]* 4.2 Write property test `lib/gameboard/access.property.test.ts` for exhaustive, gated access decision
    - **Property 1: Board access decision is exhaustive and gated**
    - **Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.6**

- [ ] 5. Implement the active-Region transition logic (`lib/gameboard/region.ts`)
  - [ ] 5.1 Implement `INITIAL_REGION = "bars"` and `selectRegion(current, target)` — sets `target` active; re-selecting the active Region returns an equal state (no change)
    - _Requirements: 2.2, 2.3, 2.6, 2.7_
  - [ ]* 5.2 Write property test `lib/gameboard/region.property.test.ts` for select + idempotence
    - **Property 2: Region transition selects the target and is idempotent on the active one**
    - **Validates: Requirements 2.2, 2.7**
  - [ ]* 5.3 Write property test in `lib/gameboard/region.property.test.ts` for exactly-one-active over random selection sequences
    - **Property 3: Exactly one Region is active**
    - **Validates: Requirements 2.6**

- [ ] 6. Checkpoint - pure reducer, model, access, and region logic
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement the wireframe card-play route (`app/api/games/[gameId]/wireframe-card-play/route.ts`)
  - [ ] 7.1 Implement POST handler mirroring `teams/select/route.ts`: `runtime = "nodejs"`; `requireSession` (401 `missing_session`) → `withTransaction` (game row `FOR UPDATE`) → `assertMember` (403 `not_member`) → validate target Team belongs to this game and differs from the caller's own Team (404 `not_found`) → `appendEvent` exactly one `wireframe_card_played` `{ castingTeamId, targetTeamId, cardId }` (actor = caster's Team) → `applied(seq)`; any throw rolls back with `notApplied` (500)
    - No score/claim mutation and no blocking of any Region or control
    - _Requirements: 7.1, 7.6, 7.7_
  - [ ]* 7.2 Write example tests `app/api/games/[gameId]/wireframe-card-play/route.test.ts` for the append + validation branches
    - Happy path appends exactly one `wireframe_card_played` event carrying the target (fake `QueryRunner`, assert a single `appendEvent`); missing session → 401; non-member → 403; target not in game / equals own Team → 404
    - _Requirements: 7.1, 7.6_
  - [ ]* 7.3 Write example test for append-failure handling (not delivered)
    - A throw inside the transaction rolls back (no event written) and the route returns `{ applied: false, error }` so the client can show "not delivered"
    - _Requirements: 7.7_

- [ ] 8. Implement the RegionNav and region-surface components (`components/board/`)
  - [ ] 8.1 Implement `RegionNav.tsx` — three navigation controls (bars/scoreboard/cards), active control visually distinguished (e.g. `aria-current`), all three always displayed and operable, each ≥44×44px touch target
    - _Requirements: 2.1, 2.4, 2.5, 9.2_
  - [ ] 8.2 Implement `BarsRegion.tsx` — placeholder view surface; placeholder claim control labeled as claiming a bar (≥44×44px); "provided by a later feature" label; activating the claim control shows an inert wireframe acknowledgement (no POST, no append, no score/claim change, regions unchanged); when Session is Admin-and-not-a-Player, show "claiming belongs to Players" instead of an operable control
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.3_
  - [ ] 8.3 Implement `ScoreboardRegion.tsx` — one placeholder row per Team (2–4), each showing the Team color, a placeholder score, a placeholder claimed-bars area, plus a "later feature" label
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 8.4 Write property test `components/board/ScoreboardRegion.property.test.tsx` for one-row-per-team rendering
    - **Property 6: Scoreboard renders one row per Team with color, score, and claimed-bars**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
  - [ ] 8.5 Implement `CardsRegion.tsx` — placeholder hand surface of 1–8 placeholder cards each with a play control; "later feature" label; when Admin-and-not-a-Player, show "a hand belongs to Players" instead of a hand
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 9. Implement the card-play and notification components (`components/board/`)
  - [ ] 9.1 Implement `CardPlayWireframe.tsx` — presented on play; for a targeting card lists every **other** Team excluding the caller's own Team; for a non-targeting card omits target selection and shows confirm directly; selecting a target shows a confirmation naming it; confirming a targeting card without a selected target shows "target required" and does not complete; confirm shows a wireframe acknowledgement and enforces nothing; cancel dismisses and leaves the region unchanged; fits within 320–430px without horizontal scroll
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.4_
  - [ ]* 9.2 Write property test `components/board/CardPlayWireframe.property.test.tsx` for the target list
    - **Property 8: Target list excludes own Team and includes every other Team**
    - **Validates: Requirements 6.2**
  - [ ] 9.3 Implement `TargetedNotification.tsx` — presents the casting Team; a "effect/restriction is a later feature" label; a dismiss control (≥44×44px); never obscures the Region nav and blocks nothing
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 9.3, 9.5_
  - [ ]* 9.4 Write component tests for the card-play and notification branches
    - R6.1 opens wireframe; R6.3 non-targeting omits selector + shows confirm; R6.4 selecting shows naming confirmation; R6.5 confirm-without-target shows "target required" and does not complete; R6.6 acknowledgement + no enforcement; R6.7 cancel leaves region unchanged; R7.4 later-feature label; R7.5 dismiss removes notice; R7.6 does not block nav/regions
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 7.4, 7.5, 7.6_

- [ ] 10. Checkpoint - server route and presentational components
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement the Game_Board page and wire everything together (`app/games/[gameId]/board/page.tsx`)
  - Mirror the lobby page: establish the async Supabase-auth Session (`establishBrowserSession` / `bindRealtimeAuth`); derive role from durable per-game facts (`bbb:admin:{gameId}`, `bbb:player:{gameId}`); compute the access decision via `selectBoardAccess` and render only the `board` decision's Regions; own active-Region state via `selectRegion` (initial `bars`); seed the view with `foldGameBoardEvents` then `subscribe(gameId, ...)` with `ReconnectController`/`ResumeController`/`LocalStorageLastSeenStore`; apply live events with `applyGameBoardEvent`; derive `Targeted_Notification`s from `view.targetedNotices` filtered to the current Team; send the one POST to `/api/games/{gameId}/wireframe-card-play` on confirm of a targeting card, surfacing "not delivered" on failure; render the unconfigured-env notice when `isSupabaseConfigured()` is false; show the "live updates unavailable — reload required" notice on subscribe/snapshot failure
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.3, 3.6, 5.4, 7.1, 7.3, 7.7, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8_
  - [ ]* 11.1 Write example/render tests `app/games/[gameId]/board/page.test.tsx` for access gating and realtime wiring
    - R1.1 live member renders Regions; R1.3 lobby redirects and renders no Regions; R1.4 ended shows indication and no Regions; R1.5 non-member not-authorized; R1.6 no session establish-session prompt; R2.1 exactly three nav controls; R2.3 initial active is Bars; R8.1 subscribes with the game id on open; R8.8 subscription/snapshot failure shows the unavailable/reload notice; wiring of `ReconnectController`/`ResumeController` present (behavior itself already property-tested in `lib/realtime`)
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.3, 8.1, 8.5, 8.6, 8.7, 8.8_
  - [ ]* 11.2 Add a reference test/comment citing the reused `lib/realtime` property suites (do NOT re-implement)
    - Ordered apply / per-game isolation / bounded reconnect / resume catch-up are reused from the foundation `lib/realtime` suites
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7_

- [ ] 12. Add the lobby→board navigation entry point (`app/games/[gameId]/lobby/page.tsx`)
  - When the lobby page folds a `game_started` event (lifecycle → `live`), present a control that navigates to `/games/{gameId}/board` within the propagation window; do not otherwise alter lobby behavior
  - _Requirements: 1.2_
  - [ ]* 12.1 Write a test asserting the lobby presents board navigation after folding `game_started`
    - Applying a `game_started` event surfaces a navigate-to-board control pointing at `/games/{gameId}/board`
    - _Requirements: 1.2_

- [ ] 13. Add mobile-first viewport coverage
  - [ ]* 13.1 Write viewport test `app/games/[gameId]/board/page.viewport.test.tsx`
    - Mirror `app/games/[gameId]/lobby/page.viewport.test.tsx`: single-column flex + `box-sizing: border-box` + no fixed px width exceeding the viewport across 320–430px; `globals.css` `overflow-x` guard; every interactive control (nav, claim, card play, dismiss) declares a ≥44×44px touch target; an active `TargetedNotification` leaves the Region nav controls present and operable
    - _Requirements: 9.1, 9.2, 9.3, 9.5_
  - [ ]* 13.2 Write viewport test `components/board/CardPlayWireframe.viewport.test.tsx`
    - Card_Play_Wireframe fits within the 320–430px band without horizontal scroll
    - _Requirements: 9.4_

- [ ] 14. Write external-infra integration checks (Supabase Realtime)
  - [ ]* 14.1 Write integration tests for Realtime delivery and channel isolation
    - R7.2 a committed `wireframe_card_played` event is delivered to the target Team's subscribed clients within 5s; R8.4 the channel delivers only the subscribed Game's events — 1–3 representative examples against a live or mocked channel, reusing the foundation transport rather than re-testing it (external infrastructure, not our logic, per the design's Testing Strategy)
    - _Requirements: 7.2, 8.4_

- [ ] 15. Final checkpoint - full in-game landing wireframe
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements clauses for traceability.
- All ten correctness properties are covered by new property tests: P1 (access), P2/P3 (region), P4/P5 (fold), P6 (scoreboard), P7 (placeholder hand), P8 (target list), P9/P10 (notices).
- No schema/migration task is required: the one new event type `wireframe_card_played` rides the existing `game_events` table (per-game `seq`, ≤16 KB payload) with no schema change.
- The reconnect/resume/ordered-apply/isolation machinery is **reused** from the already-property-tested `lib/realtime` suites and is referenced in place (task 11.2), not re-implemented.
- R7.2 (Realtime delivery within 5s) and R8.4 (channel isolation) exercise external Supabase infrastructure, so they are represented as 1–3 representative integration examples (task 14.1), matching the design's Testing Strategy.
- Property tests use fast-check with a minimum of 100 iterations, co-located as `*.property.test.ts(x)`, matching existing suites.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "4.2", "5.2", "5.3", "7.1", "8.1", "8.2", "8.3", "8.5", "9.1", "9.3"] },
    { "id": 3, "tasks": ["7.2", "7.3", "8.4", "9.2", "9.4"] },
    { "id": 4, "tasks": ["11", "12"] },
    { "id": 5, "tasks": ["11.1", "11.2", "12.1", "13.1", "13.2", "14.1"] }
  ]
}
```
