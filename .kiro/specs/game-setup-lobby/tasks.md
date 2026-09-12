# Implementation Plan: Game Setup & Lobby

## Overview

This plan implements the Game Setup & Lobby feature (ROADMAP F1.1–F1.3) by building thin new
code on top of the web-app-foundation backbone, exactly as the design prescribes: pure
lobby-domain logic in `lib/lobby/`, a durable client session store in `lib/session/`, six
transactional server route handlers under `app/api/games/`, and a mobile-first Lobby_Client
(`components/lobby/*` + `app/games/[gameId]/lobby/page.tsx`).

The approach is test-driven with **Vitest** + **fast-check**. Each of the design's 25
correctness properties maps to a co-located `*.property.test.ts` task. Properties the design
marks as **reused** from the foundation (Properties 8, 10, 19, 22, 23, 24) are referenced in
place rather than re-implemented. No schema changes are required — foundation migration 0001
already models every persisted concept.

Tasks are ordered so each builds on the previous: pure logic first (unit-testable in
isolation), then the event fold/reducer, then the session store, then routes that wrap the
pure logic in `withTransaction` + `appendEvent`, then the client that subscribes and renders,
then DB-backed integration and viewport coverage that wires it all together.

## Tasks

- [ ] 1. Scaffold `lib/lobby/` pure-logic modules and shared constants
  - Create `lib/lobby/` directory with `joinCode.ts`, `displayName.ts`, `team.ts` module skeletons
  - Define exported constants and discriminated result types per design §Components 1a–1c
    (`JOIN_CODE_ALPHABET`, `GENERATED_CODE_LENGTH`, `MAX_CODE_GEN_ATTEMPTS`, `MIN/MAX_DISPLAY_NAME`,
    `MAX_TEAM_NAME`, `TEAM_COLORS`)
  - Confirm reuse imports resolve: `validateBarDesignation` from `lib/games`, `canStartGame`/`MAX_TEAMS` from `lib/gameend`
  - _Requirements: 1.4, 3.5, 4.4, 4.7_

- [ ] 2. Implement Join_Code generation and validation (`lib/lobby/joinCode.ts`)
  - [ ] 2.1 Implement `generateJoinCode`, `isValidGeneratedCode`, `isValidSubmittedCode`, `normalizeSubmittedCode`
    - Generate 6–8 chars from `JOIN_CODE_ALPHABET` with injectable RNG; validate generated (6–8) vs submitted (6–12) shape; normalize = trim + upcase
    - _Requirements: 1.4, 3.3_
  - [ ]* 2.2 Write property test `lib/lobby/joinCode.property.test.ts` for generated-code shape
    - **Property 2: Generated Join_Codes have valid, acceptable shape**
    - **Validates: Requirements 1.4**
  - [ ]* 2.3 Write property test in `lib/lobby/joinCode.property.test.ts` for submitted-code acceptance
    - **Property 3: Submitted Join_Code format acceptance**
    - **Validates: Requirements 3.3**
  - [ ]* 2.4 Write unit tests for Join_Code edge cases
    - Empty, too-short, too-long, non-alphanumeric, whitespace-padded submissions; normalization round-trips
    - _Requirements: 1.4, 3.3_

- [ ] 3. Implement display-name validation (`lib/lobby/displayName.ts`)
  - [ ] 3.1 Implement `validateDisplayName` (trim, then require 1–40 chars, discriminated result)
    - _Requirements: 3.5, 3.6_
  - [ ]* 3.2 Write property test `lib/lobby/displayName.property.test.ts`
    - **Property 4: Display-name validation and trimming**
    - **Validates: Requirements 3.5, 3.6**

- [ ] 4. Implement team validation and creation decision (`lib/lobby/team.ts`)
  - [ ] 4.1 Implement `validateTeamName` and `decideCreateTeam`
    - `validateTeamName`: trimmed 1–100 chars; `decideCreateTeam`: gate on `existingColors.length < MAX_TEAMS`, assign first free `TEAM_COLORS` entry distinct from existing
    - _Requirements: 4.2, 4.3, 4.4, 4.7_
  - [ ]* 4.2 Write property test `lib/lobby/team.property.test.ts` for team-name validation
    - **Property 5: Team-name validation and trimming**
    - **Validates: Requirements 4.4, 4.7**
  - [ ]* 4.3 Write property test in `lib/lobby/team.property.test.ts` for the create-team count gate
    - **Property 6: Create-team count gate**
    - **Validates: Requirements 4.2, 4.3**
  - [ ]* 4.4 Write property test in `lib/lobby/team.property.test.ts` for distinct color assignment
    - **Property 7: Assigned team color is distinct from existing teams**
    - **Validates: Requirements 4.4**
  - [ ]* 4.5 Write unit test for color-assignment ordering (first free palette color) and result shapes
    - _Requirements: 4.4_

- [ ] 5. Implement lobby-phase and authorization gate helpers (`lib/lobby/gate.ts`)
  - [ ] 5.1 Implement pure gates: `isLobbyPhase(lifecycle)`, `isAdmin(adminSessionId, requesterSessionId)`, `isMember(memberSessionIds, requesterSessionId)`, and the start-bar-designation gate (`bothBarsDesignated`)
    - _Requirements: 2.6, 2.8, 3.4, 4.8, 5.5, 5.6, 5.7, 8.4, 8.5, 8.8_
  - [ ]* 5.2 Write property test `lib/lobby/gate.property.test.ts` for the start-both-bars gate
    - **Property 9: Start requires both bars designated**
    - **Validates: Requirements 5.5**
  - [ ]* 5.3 Write property test in `lib/lobby/gate.property.test.ts` for the lobby-phase gate
    - **Property 11: Lobby-phase gate**
    - **Validates: Requirements 2.6, 3.4, 4.8, 5.7**
  - [ ]* 5.4 Write property test in `lib/lobby/gate.property.test.ts` for the admin-authorization gate
    - **Property 12: Admin-authorization gate**
    - **Validates: Requirements 2.8, 5.6, 8.1, 8.8**
  - [ ]* 5.5 Write property test in `lib/lobby/gate.property.test.ts` for the membership-authorization gate
    - **Property 13: Membership-authorization gate**
    - **Validates: Requirements 8.4, 8.5**

- [ ] 6. Reference reused foundation property suites for bar-differ and start-count
  - [ ]* 6.1 Add a reference test/comment in `lib/lobby/` citing the reused bar-designation and start-count suites (do NOT re-implement)
    - **Property 8: Start-game team-count bound** — reuses existing `lib/gameend` suite
    - **Property 10: Bar designation start ≠ finish** — reuses existing `lib/games` suite
    - **Validates: Requirements 2.3, 5.1, 5.3, 5.4**

- [ ] 7. Implement lobby event types and reducer (`lib/lobby/events.ts`)
  - [ ] 7.1 Define `LOBBY_EVENT_TYPES`, `LobbyView`/`LobbyTeamView`/`LobbyPlayerView`, and implement `initialLobbyView`, `applyLobbyEvent` (seq-ordered, idempotent at/below `lastSeenSequence`), `foldLobbyEvents`
    - Plug into the existing snapshot fold seam (`lib/realtime/snapshot.ts`); advance `lastSeenSequence` per applied event
    - _Requirements: 7.2, 7.3_
  - [ ]* 7.2 Write property test `lib/lobby/events.property.test.ts` for snapshot == ordered fold
    - **Property 20: Lobby snapshot equals the ordered fold**
    - **Validates: Requirements 7.2**
  - [ ]* 7.3 Write property test in `lib/lobby/events.property.test.ts` for apply-once-in-order under duplicates/reordering
    - **Property 21: Lobby reducer applies each event once, in order**
    - **Validates: Requirements 7.3**

- [ ] 8. Reference reused realtime property suites (ordered apply, isolation, reconnect, resume)
  - [ ]* 8.1 Add a reference test/comment citing the reused `lib/realtime` suites (do NOT re-implement)
    - **Property 22: Per-game isolation of applied events** — reuses foundation isolation suite
    - **Property 23: Bounded reconnect schedule** — reuses foundation reconnect suite
    - **Property 24: Resume catch-up delivers exactly the missed tail** — reuses foundation resume suite
    - **Validates: Requirements 7.4, 7.5, 7.6**

- [ ] 9. Checkpoint - pure lobby logic and reducer
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement durable client session store (`lib/session/`)
  - [ ] 10.1 Create `lib/session/sessionStore.ts` mirroring `LocalStorageLastSeenStore`
    - `StorageLike` seam, `SessionStore` with `get`/`set`/`getOrCreate` (probe-and-fallback, never throw, in-memory degrade), and `newSessionId` (crypto.randomUUID + fallback)
    - _Requirements: 8.6, 8.7, 8.9_
  - [ ]* 10.2 Write property test `lib/session/sessionStore.property.test.ts`
    - **Property 25: Durable session persistence and fallback**
    - **Validates: Requirements 8.6, 8.7, 8.9**
  - [ ]* 10.3 Write unit tests for absent/corrupt/unusable storage fallback behavior
    - _Requirements: 8.9_

- [ ] 11. Implement shared route auth/session helpers (`app/api/games/_shared.ts`)
  - Implement `requireSession(request)` (reads `x-bbb-session-id`), `assertMember(tx, gameId, sessionId)`, `assertAdmin(tx, gameId, sessionId)` — lifting `MEMBERSHIP_SQL`/`ADMIN_CHECK_SQL` from existing routes; checks run inside the transaction against a `FOR UPDATE`-locked game row
  - Define the shared structured response shape `{ applied, seq?, error? }` and the error→HTTP status map from design §Error Handling
  - _Requirements: 1.3, 8.3, 8.4, 8.5, 6.4, 6.5_

- [ ] 12. Implement create-game route (`app/api/games/route.ts`)
  - [ ] 12.1 Implement POST handler: `requireSession` → `withTransaction` → generate Join_Code + retry up to `MAX_CODE_GEN_ATTEMPTS` on unique-violation → insert game (`lifecycle=lobby`, `admin_session_id=session`) → `appendEvent` `game_created` → return `{ gameId, joinCode, seq }`
    - On exhausted attempts or any throw, roll back (no game, no event); missing session → 401
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 6.1, 8.1_
  - [ ]* 12.2 Write property test for admin session recorded verbatim on create
    - **Property 1: Admin session is recorded verbatim on create**
    - **Validates: Requirements 1.2, 8.1**

- [ ] 13. Implement designate-bars route (`app/api/games/[gameId]/bars/route.ts`)
  - Implement POST handler: `assertAdmin` → lobby-phase gate → bar-existence check → `validateBarDesignation` (start ≠ finish) → update `start_bar_id`/`finish_bar_id` → `appendEvent` `bars_designated`
  - Map rejections: not-admin 403, lobby-closed 409, bar-not-found 404, start=finish 400; leave existing designation unchanged on rejection
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 6.1_

- [ ] 14. Implement join-game route (`app/api/games/[gameId]/join/route.ts`)
  - Implement POST handler: `requireSession` → validate submitted code format + match game → lobby-phase gate → `validateDisplayName` → idempotent insert on `(game_id, session_id)` (return existing player if present) → `appendEvent` `player_joined`
  - Map rejections: invalid-code 400, not-found 404, lobby-closed 409, invalid-display-name 400
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.6, 6.1, 8.2_
  - [ ]* 14.1 Write property test for join idempotence (one player per session per game)
    - **Property 14: One player per session per game (join idempotence)**
    - **Validates: Requirements 3.8, 8.2**
  - [ ]* 14.2 Write property test for join recording session + trimmed name
    - **Property 15: Join records the joining session and trimmed name**
    - **Validates: Requirements 3.7**

- [ ] 15. Implement create-team route (`app/api/games/[gameId]/teams/route.ts`)
  - Implement POST handler: `assertMember` → lobby-phase gate → `decideCreateTeam(existingColors, name)` → insert team with assigned color → `appendEvent` `team_created`
  - Map rejections: not-member 403, lobby-closed 409, team-limit-reached 409, invalid-team-name 400
  - _Requirements: 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 6.1_

- [ ] 16. Implement team-select/switch route (`app/api/games/[gameId]/teams/select/route.ts`)
  - Implement POST handler: `assertMember` → lobby-phase gate → `UPDATE players SET team_id = $target` (composite FK keeps team in same game) → `appendEvent` `team_changed`
  - Map rejections: not-member 403, lobby-closed 409
  - _Requirements: 4.1, 4.5, 4.6, 4.8, 6.1_
  - [ ]* 16.1 Write property test for team switch yielding exactly one association
    - **Property 16: Team switch yields exactly one team association**
    - **Validates: Requirements 4.5**

- [ ] 17. Implement start-game route (`app/api/games/[gameId]/start/route.ts`)
  - Implement POST handler: `assertAdmin` → lobby-phase gate → `canStartGame(teamCount)` (2–4) → both-bars gate → set `lifecycle=live` + `live_started_at` → `appendEvent` `game_started`
  - Map rejections: not-admin 403, not-in-lobby 409, min-teams/max-teams 409, bars-missing 409; leave lifecycle unchanged on rejection
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1_

- [ ] 18. Add transactional-atomicity property coverage across routes
  - [ ]* 18.1 Write property test for atomic single-event append per lobby change (reuses foundation `withTransaction` + `appendEvent` seam)
    - **Property 17: Atomic single-event append per lobby change**
    - **Validates: Requirements 6.1**
  - [ ]* 18.2 Write property test for rollback leaving nothing persisted on failure
    - **Property 18: Rollback leaves nothing persisted on failure**
    - **Validates: Requirements 6.2, 6.3**
  - [ ]* 18.3 Add reference test/comment citing the reused gap-free per-game sequence suite (do NOT re-implement)
    - **Property 19: Gap-free contiguous per-game sequence under serialization** — reuses foundation `nextSeq`/`FOR UPDATE` suite
    - **Validates: Requirements 6.6**

- [ ] 19. Checkpoint - server routes and transactional guarantees
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 20. Implement Lobby_Client presentational components (`components/lobby/`)
  - [ ] 20.1 Implement `CreateGame.tsx` (create form + bar designation) and `JoinGame.tsx` (code entry + display-name form)
    - Mobile-first single-column layout, ≥44×44px touch targets
    - _Requirements: 9.1, 9.2_
  - [ ] 20.2 Implement `TeamSelection.tsx` (team list, create-team, join/switch) and `StartGame.tsx` (admin start button, enabled only when eligible)
    - _Requirements: 9.1, 9.2_
  - [ ] 20.3 Implement `LobbyRoster.tsx` (Join_Code display, teams with colors, players per team)
    - _Requirements: 9.3, 9.4_

- [ ] 21. Implement the lobby page and wire everything together (`app/games/[gameId]/lobby/page.tsx`)
  - Wire components; own `SessionStore` (send `x-bbb-session-id`), the `subscribe(gameId, ...)` lifecycle, and `LobbyView` state updated via `applyLobbyEvent`; use `ReconnectController`/`ResumeController` from `lib/realtime`
  - Send POSTs to the six routes; render roster updates from applied events
  - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6, 8.6, 8.7, 9.5_
  - [ ]* 21.1 Write viewport test `app/games/[gameId]/lobby/page.viewport.test.tsx`
    - Single-column, no horizontal overflow at 360–430px; controls ≥44×44px
    - _Requirements: 9.1, 9.2_
  - [ ]* 21.2 Write component render tests for roster and live update
    - Join_Code shown; teams/colors/players shown; applying a team/player event updates the roster
    - _Requirements: 9.3, 9.4, 9.5_

- [ ] 22. Write DB-backed integration tests (Supabase, `supabase/__tests__` convention)
  - [ ]* 22.1 Create/lifecycle/join-code integration tests
    - Create → `lobby` + `{ gameId, joinCode }` + one `game_created`; missing session rejected; forced-collision generator exhausts and writes nothing
    - _Requirements: 1.1, 1.3, 1.5, 1.6, 1.7, 1.8_
  - [ ]* 22.2 Bars, join, team, and start integration tests
    - Bars recorded/mutable/unknown-not-found; join match vs unknown code + player recorded; team join sets `team_id`; each of join/create/switch writes exactly one event; start sets `live` + `live_started_at` + one `game_started`
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.7, 3.1, 3.2, 3.7, 4.1, 4.6, 5.1, 5.2, 5.8_
  - [ ]* 22.3 Atomic-result-shape and realtime/RLS integration tests
    - Success `{ applied:true, seq }`; rejection `{ applied:false, reason }` with nothing persisted; realtime delivery to subscriber within 5s; per-game RLS isolation (1–2 representative examples)
    - _Requirements: 6.4, 6.5, 7.1, 7.4_

- [ ] 23. Final checkpoint - full lobby lifecycle
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements clauses for traceability.
- All 25 correctness properties are covered: new property tests for Properties 1–7, 9, 11–18, 20, 21, 25; reused foundation suites referenced (not re-implemented) for Properties 8, 10, 19, 22, 23, 24.
- No schema/migration tasks: foundation migration 0001 already models games, teams, players, bars, and the `game_events` log.
- Property tests use fast-check with `{ numRuns: 100 }`, co-located as `*.property.test.ts`, matching existing suites.
- Integration and viewport/component tests cover DB-backed behavior, external Supabase behavior, and UI, per the design's Testing Strategy.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "7.1", "10.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "4.2", "4.3", "4.4", "4.5", "5.2", "5.3", "5.4", "5.5", "6.1", "7.2", "7.3", "8.1", "10.2", "10.3"] },
    { "id": 3, "tasks": ["11"] },
    { "id": 4, "tasks": ["12.1", "13", "14", "15", "16", "17"] },
    { "id": 5, "tasks": ["12.2", "14.1", "14.2", "16.1", "18.1", "18.2", "18.3", "20.1", "20.2", "20.3"] },
    { "id": 6, "tasks": ["21"] },
    { "id": 7, "tasks": ["21.1", "21.2", "22.1", "22.2", "22.3"] }
  ]
}
```
