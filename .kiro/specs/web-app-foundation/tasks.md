# Implementation Plan: Web App Foundation

## Overview

This plan implements the BBB web-app foundation defined in `design.md`: the hosting/stack
decision record, the Next.js + TypeScript scaffold targeting Vercel, the full-v1 Supabase
data schema and append-only event backbone, the pure scoring/game-end logic, the real-time
propagation client (subscribe, snapshot, dual-path recovery), and secrets/access safety
(RLS, secret scanning). Implementation language is **TypeScript** on **Next.js (App Router)
/ Node.js**, with **Supabase** (Postgres + Realtime) and **fast-check** for property tests
(minimum 100 iterations each; every property test tagged
`Feature: web-app-foundation, Property {number}: {property_text}`).

Tasks are ordered so pure logic and schema land first, the event backbone and server routes
wire onto them, then the realtime client, baseline page, and end-to-end demonstration tie it
all together. Test sub-tasks are marked `*` (optional/skippable) and live next to the code
they cover. Documentation-only and live-transport-dependent tasks are marked as manual /
environment-dependent where noted.

## Tasks

- [ ] 1. Initialize scaffold, tooling, and repository structure
  - [ ] 1.1 Initialize the Next.js (App Router) + TypeScript project targeting Vercel
    - Create the Node.js project (`package.json`, `tsconfig.json`, `next.config`) as a
      Next.js App Router app on Node.js, configured for the Vercel hosting target
    - Create the directory layout: `app/`, `components/`, `lib/`, `supabase/`, `public/`
    - Add a `.nvmrc`/engines field pinning the Node version
    - _Requirements: 2.1, 2.2_

  - [ ] 1.2 Add linter and formatter configs each with a project command
    - Configure ESLint (with the Next.js/TypeScript ruleset) and Prettier
    - Add `lint` and `format`/`format:check` scripts to `package.json` so each is invocable
      through a defined project command
    - Ensure the freshly scaffolded code passes with zero lint errors and zero format
      violations
    - _Requirements: 2.4, 2.5, 2.6_

  - [ ] 1.3 Configure `.gitignore` for secret-bearing files
    - Exclude `.env*` from version control while explicitly keeping `.env.example`
    - _Requirements: 7.1_

- [ ] 2. Environment configuration and fail-fast validation
  - [ ] 2.1 Implement `lib/env` `loadEnv()` with fail-fast validation
    - Define the required variable set: public `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`; server-only `SUPABASE_SERVICE_ROLE_KEY`
    - `loadEnv()` returns a typed, frozen config object, or throws a startup error that
      enumerates **every** missing/empty required variable by name (not just the first),
      leaving the app in a not-started state
    - Keep the service-role key server-only; expose only `NEXT_PUBLIC_*` to the browser
    - _Requirements: 2.7, 2.9, 7.3_

  - [ ] 2.2 Create the committed `.env.example`
    - List every required environment variable by name with placeholder (non-secret) values,
      covering local, preview, and production usage
    - _Requirements: 2.7, 2.8_

  - [ ] 2.3 Wire `loadEnv()` into server startup
    - Invoke validation before the server accepts any request so a missing/empty var halts
      startup before serving
    - _Requirements: 2.9_

  - [ ]* 2.4 Write property test for env fail-fast validation
    - **Property 15: Startup env validation reports exactly the missing variables**
    - Generate a random subset `S` of required vars omitted/blanked; assert validation halts
      pre-start and the reported names equal exactly `S`; when `S` is empty, validation
      succeeds
    - **Validates: Requirements 2.9**

- [ ] 3. Pure scoring logic (`lib/scoring`)
  - [ ] 3.1 Implement `computeShares(claimingTeamCount)`
    - Return the per-team non-finish-bar share (1→12, 2→6, 3→4, 4→3); expose the finish-bar
      solo-12 award
    - _Requirements: 3.13_

  - [ ]* 3.2 Write property test for the scoring split
    - **Property 1: Non-finish bar 12-point split**
    - For `k` in 1..4 assert exact table values and that shares sum to exactly 12; assert the
      finish-bar award is exactly 12 for a single claimer
    - **Validates: Requirements 3.13**

- [ ] 4. Pure game-end logic (`lib/gameend`)
  - [ ] 4.1 Implement `isDueForAutoTimeout(liveStartedAt, now)` and `canEndGame(lifecycle)`
    - `isDueForAutoTimeout` is true iff `now - liveStartedAt ≥ 12h`
    - `canEndGame` is true iff `lifecycle === 'live'`; model that `end_reason` is immutable
      once set (helper/guard that rejects re-ending)
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [ ]* 4.2 Write property test for the auto-timeout predicate
    - **Property 8: Auto-timeout is due exactly at 12 hours**
    - Generate `live_started_at` and `now` around the 12h boundary; assert due iff
      `now - t ≥ 12h`
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 4.3 Write property test for the end guard and immutable end_reason
    - **Property 9: End transition is guarded by lifecycle and end_reason is immutable**
    - Generate random lifecycle states and end attempts; assert end permitted iff `live`,
      lobby/ended rejected leaving lifecycle unchanged, and `end_reason` never changes once set
    - **Validates: Requirements 5.4, 5.5**

- [ ] 5. Team-count start guard (pure)
  - [ ] 5.1 Implement the start-eligibility guard in `lib/gameend` (or `lib/teams`)
    - A pure predicate permitting a `live` transition iff `2 ≤ n ≤ 4` teams
    - _Requirements: 3.6_

  - [ ]* 5.2 Write property test for the team-count bound
    - **Property 2: Team-count bound per game**
    - Generate `n` including 0,1,5,6; accept iff `2 ≤ n ≤ 4`
    - **Validates: Requirements 3.6**

- [ ] 6. Checkpoint - pure logic verified
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Database migrations: core game schema (`supabase/`)
  - [ ] 7.1 Create the games/teams/players/bars migration
    - `games` (lifecycle enum lobby/live/ended, nullable `start_bar_id`/`finish_bar_id` FKs,
      `live_started_at`, `end_reason` enum {finish_bar_claimed, admin_ended, auto_timeout},
      `admin_session_id`, unique `join_code`, `created_at`); start/finish must differ and
      reference a bar in this game
    - `teams` (`game_id` FK, `name`, `color`, `created_at`)
    - `players` (`team_id` FK, `game_id`, `session_id`, `display_name`, `created_at`) —
      session-based identity, no cross-game identity records
    - `bars` (`game_id` FK, `name`, nullable `location`, `created_at`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.14, 3.15_

  - [ ] 7.2 Create the claims migration
    - `claims` (`game_id`, `team_id` FK, `bar_id` FK, `claimed_at`) with a **unique
      (game_id, team_id, bar_id)** constraint enforcing no re-claiming
    - _Requirements: 3.8, 3.9, 3.13, 3.14_

  - [ ] 7.3 Create the card_definitions / card_instances / card_plays migration
    - `card_definitions` (unique `slug`, `name`, `card_type` enum {opponent_slowing,
      economy_boost, reactive}, `requires_target` boolean, nullable `validation_modality`,
      nullable `casting_cost` jsonb, nullable `timer_seconds`, `effect_summary`)
    - `card_instances` (`game_id`, `definition_id` FK, nullable `holder_team_id`, `state` enum
      {in_hand, played, discarded}, `created_at`)
    - `card_plays` (`game_id`, `card_instance_id` FK, `casting_team_id` FK, nullable
      `target_team_id` FK, `played_at`)
    - _Requirements: 3.1, 3.10, 3.11, 3.12, 3.14_

  - [ ] 7.4 Create the seed migration for the full v1 card catalog
    - Seed `card_definitions` with EVERY finalized v1 card from `cards.md`:
      opponent_slowing (Go Piss Girl, Crop Dusting [no target], Moneybags, Use It or Lose It,
      Wired, Art School Dropout, Broad Shoulders, Bird Guide, Interested Buyer, Different
      Tastes, Everyone's a Critic, Quit Nursing, Cancel Culture [no target], Spin Cycle,
      Dirty Bird, Scenic Route); economy_boost (Heavyweight, Insured, Happy Hour, Power Hour,
      Party Crasher, Patient Investor, Window Shopping); reactive (Fairest of Them All)
    - Set `requires_target` correctly (false for Crop Dusting, Cancel Culture, and self/economy
      cards)
    - _Requirements: 3.10, 3.14_

  - [ ]* 7.5 Write unit/example tests for schema shape and card catalog seed
    - Assert the seeded `card_definitions` set equals the finalized v1 set from `cards.md`,
      each row has a valid `card_type` and boolean `requires_target`, and no-target cards are
      `false`
    - Assert enum shapes for lifecycle, card-instance state, and end_reason
    - _Requirements: 3.2, 3.4, 3.10, 3.11_

  - [ ]* 7.6 Write unit/example tests for start/finish designation
    - Setting `finish == start` is rejected; each of start and finish is exactly one per game
    - _Requirements: 3.7_

  - [ ]* 7.7 Write property test for no-duplicate-claim (pure model)
    - **Property 3: No duplicate claim**
    - Model repeated claims for a (game, team, bar); first accepted, subsequent rejected,
      count stays 1
    - **Validates: Requirements 3.9**

- [ ] 8. Database migrations: append-only game_events backbone (`supabase/`)
  - [ ] 8.1 Create the game_events migration with immutability and sequence constraints
    - `game_events` (`id`, `game_id` FK, `seq` bigint, `event_type`, `actor` [team id |
      `admin` | `system`], `payload` jsonb with a **≤ 16 KB** check, `created_at` timestamptz
      UTC ms), **unique (game_id, seq)**
    - Insert-only: grant no UPDATE/DELETE to app roles and add a BEFORE UPDATE/DELETE trigger
      that raises to reject any modification
    - _Requirements: 3.1, 4.1, 4.2, 4.5, 4.6, 3.14_

  - [ ]* 8.2 Write property test for event immutability / insert-only (pure model)
    - **Property 4: Game events are immutable and insert-only**
    - For random committed events in a non-ended game, every update/delete attempt is
      rejected and fields remain unchanged
    - **Validates: Requirements 4.1, 4.6**

- [ ] 9. Event backbone (`lib/events`)
  - [ ] 9.1 Implement `appendEvent(tx, { gameId, type, actor, payload })`
    - Executes inside the caller's transaction; assigns the next per-game `seq` under a
      per-game lock (game-row `FOR UPDATE` or advisory lock); enforces payload ≤ 16 KB and a
      UTC-ms timestamp; returns the created event
    - _Requirements: 4.1, 4.2, 4.5_

  - [ ]* 9.2 Write property test for payload size bound
    - **Property 5: Event payload size bound**
    - Generate payloads around the 16 KB boundary; append succeeds iff ≤ 16 KB, else rejected
      with no event written
    - **Validates: Requirements 4.2**

  - [ ]* 9.3 Write property test for per-game sequence contiguity/order
    - **Property 7: Per-game sequence is contiguous, gap-free, and matches write order**
    - Model random interleavings/concurrency of N appends; assert seqs are contiguous,
      strictly increasing, duplicate-free, and ordering by `seq` reproduces commit order
    - **Validates: Requirements 4.5**

- [ ] 10. Server mutation route + atomic state-change-plus-event write
  - [ ] 10.1 Implement a demonstration server mutation route (`app/.../route`)
    - Server-only route using the service key; accepts an authenticated game-scoped request,
      performs the domain write and exactly one `appendEvent` inside one transaction, returns
      the new event's `seq` on success or a structured "not applied" error on failure
    - On event-write failure the whole transaction rolls back (no domain change, log
      unchanged)
    - _Requirements: 4.3, 4.4_

  - [ ] 10.2 Implement the game-end transition as a Game_State_Change
    - An end transition (admin-ended / auto-timeout) writes `ended` + `end_reason` AND appends
      exactly one `game_event` in the same transaction; guarded by `canEndGame` (reject
      non-live and already-ended, leaving lifecycle/end_reason unchanged)
    - _Requirements: 5.1, 5.3, 5.4, 5.5_

  - [ ] 10.3 Implement the scheduled auto-timeout sweep
    - A Supabase scheduled function / pg_cron job that selects live games with
      `live_started_at` older than 12h and ends each via the same atomic end transition
    - _Requirements: 5.2, 5.3_

  - [ ]* 10.4 Write property test for atomic state+event write (incl. end transitions)
    - **Property 6: Atomic state-change-plus-event write**
    - Model random mutations including end transitions with an injected event-write failure;
      success → exactly +1 event; failure → 0 new events, both state and log unchanged, error
      returned
    - **Validates: Requirements 4.3, 4.4, 5.3**

- [ ] 11. Row-Level Security policies (`supabase/`)
  - [ ] 11.1 Add RLS policies for per-game isolation
    - Enable RLS on every game-scoped table; policies allow a session to read/write a row only
      when its game membership matches the row's `game_id`; the anon key is always subject to
      RLS while the service key (server routes) bypasses it for trusted writes
    - _Requirements: 7.2_

- [ ] 12. Checkpoint - schema, backbone, and access control verified
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Realtime client: subscribe, snapshot, ordered apply (`lib/realtime`)
  - [ ] 13.1 Implement the snapshot loader
    - Load an initial state snapshot that reflects all events with `seq ≤ N` persisted before
      the subscription (folded in ascending order)
    - _Requirements: 6.4_

  - [ ] 13.2 Implement `subscribe(gameId, handlers)` and `onEvent(event)`
    - Subscribe to Supabase Postgres-changes on `game_events` filtered by `game_id`; request
      the snapshot in the same flow; `onEvent` applies events in ascending `seq`, buffering /
      reordering / de-duplicating out-of-order arrivals; update `Last_Seen_Sequence` to the
      highest applied `seq`
    - _Requirements: 6.1, 6.3, 6.4, 6.6, 6.9_

  - [ ] 13.3 Persist `Last_Seen_Sequence` client-side
    - Persist to local storage so it survives app open/close
    - _Requirements: 6.6, 6.7_

  - [ ]* 13.4 Write property test for snapshot fold
    - **Property 10: Snapshot equals the fold of all prior events**
    - For random event logs up to `N`, snapshot == reduce(applyEvent, events with seq ≤ N) in
      ascending order
    - **Validates: Requirements 6.4**

  - [ ]* 13.5 Write property test for ordered apply
    - **Property 13: Client applies events in sequence order**
    - For random permutations/duplicates of an event batch, applied order == ascending `seq`,
      deduped
    - **Validates: Requirements 6.9**

- [ ] 14. Realtime client: dual-path recovery (`lib/realtime`)
  - [ ] 14.1 Implement transient in-app reconnect (path a)
    - On connection loss while the app is open, retry at intervals ≤ 5s, max 12 attempts; each
      reconnect fetches events after `Last_Seen_Sequence`, resubscribes, and re-requests a
      snapshot; only after exhausting 12 attempts surface a terminal "reload" state
    - _Requirements: 6.5_

  - [ ] 14.2 Implement `onResume()` resume/relaunch re-initialization (path b)
    - A `visibilitychange` / foreground / relaunch hook that ALWAYS re-initializes regardless
      of any prior retry budget: fetch all `Game_Events` with `seq > Last_Seen_Sequence`,
      resubscribe, and load a current snapshot; never enter a terminal "reload required" state
    - _Requirements: 6.7, 6.8_

  - [ ]* 14.3 Write property test for reconnect schedule bounds (transient path)
    - **Property 11: Reconnect schedule stays within bounds**
    - For attempt index `i` (incl. > 12) on the transient path, delay ≤ 5000ms and no attempt
      scheduled once `i > 12`
    - **Validates: Requirements 6.5**

  - [ ]* 14.4 Write property test for resume catch-up completeness
    - **Property 12: Resume catch-up delivers exactly the missed events**
    - For random `Last_Seen_Sequence` `L`, random persisted event set, and arbitrary retry
      budget state, delivered == events with `seq > L`, ascending, no gaps/dupes, independent
      of the transient retry budget
    - **Validates: Requirements 6.7**

- [ ] 15. Per-game isolation property (delivery + data access)
  - [ ]* 15.1 Write property test for per-game isolation
    - **Property 14: Per-game isolation of delivery and data access**
    - For distinct games A/B and a client scoped to G, delivered/authorized set == events with
      `game_id == G`; cross-game access is denied and leaves B's data unchanged
    - **Validates: Requirements 6.3, 7.2**

- [ ] 16. Deployable baseline + propagation demo page (`app`, `components`)
  - [ ] 16.1 Implement the mobile-first "hello world" baseline page
    - A page reachable at the public Vercel URL that renders a running indicator and reports no
      server error; mobile-first so content fits 320–375px viewports with no horizontal scroll
      or clipping
    - _Requirements: 2.10, 2.11_

  - [ ] 16.2 Implement the end-to-end propagation demo view
    - A small view that subscribes via `lib/realtime` and, when a `Game_State_Change` is
      persisted via the demo mutation, renders the received event — the F0.3 demonstration
    - _Requirements: 6.10_

  - [ ]* 16.3 Write unit/example tests for the mobile viewport
    - Render the baseline at 320px and 375px widths; assert no horizontal overflow and no
      clipped content
    - _Requirements: 2.11_

- [ ] 17. Checkpoint - realtime client and baseline verified
  - Ensure all tests pass, ask the user if questions arise.

- [ ]* 18. Integration tests against a live Supabase/Postgres instance (environment-dependent)
  - [ ]* 18.1 End-to-end propagation latency (also the F0.3 demonstration)
    - With two subscribed clients, persist one `Game_State_Change` and assert the second
      client receives the corresponding event with commit-to-receive latency < 3 seconds
    - _Requirements: 6.1, 6.2, 6.10_

  - [ ]* 18.2 Live-channel isolation
    - A client subscribed to game A receives no events from game B (1–2 representative cases)
    - _Requirements: 6.3_

  - [ ]* 18.3 Snapshot-on-subscribe and reconnect resync
    - Subscribe returns a snapshot reflecting all prior events within 3s; force-drop the
      connection and confirm reconnect + resync deliver a fresh snapshot
    - _Requirements: 6.4, 6.5_

  - [ ]* 18.4 Resume after background/relaunch
    - With `Last_Seen_Sequence` persisted, simulate a visibility cycle and a full relaunch;
      confirm catch-up on all events with `seq > Last_Seen_Sequence` and no terminal "reload
      required" state, independent of the transient retry budget
    - _Requirements: 6.7, 6.8_

  - [ ]* 18.5 RLS cross-game denial
    - A session scoped to game A is denied read/write on game B rows via the live database and
      B's data is unchanged
    - _Requirements: 7.2_

- [ ]* 19. Smoke / config checks (environment-dependent where noted)
  - [ ]* 19.1 Lint and format-check smoke checks
    - Assert the lint command reports zero errors and format-check reports zero violations
    - _Requirements: 2.5, 2.6_

  - [ ]* 19.2 `.env.example` completeness check
    - Assert `.env.example` lists every required variable name (matching `loadEnv`'s required
      set) with placeholder values
    - _Requirements: 2.8_

  - [ ]* 19.3 Migrations-apply and schema smoke check
    - Assert migrations apply cleanly and create the expected tables, enums, and constraints
    - _Requirements: 3.14_

  - [ ]* 19.4 Baseline URL responds check
    - Assert the baseline URL returns a running, non-error response
    - _Requirements: 2.10_

  - [ ]* 19.5 Secret-safety checks
    - Assert `.gitignore` excludes `.env*` while keeping `.env.example`; the browser bundle
      exposes only `NEXT_PUBLIC_*` (no service-role key); and a secret-scanning check reports
      no findings on the repository
    - _Requirements: 7.1, 7.3, 7.4_

- [ ] 20. Documentation artifacts and steering updates (manual verification)
  - [ ]* 20.1 Record the Hosting_Decision_Record as a decision doc (manual)
    - Capture the locked Vercel + Supabase decision (per-capability verdicts, real-time
      verdict, rough monthly USD cost per option, locked choice + rationale, no-deviation
      note, Identity_Model and Photo_Lifecycle_Policy resolutions, deferred items naming
      F2.1/F2.3) as an ADR/decision doc mirroring design.md's Architecture section
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [ ] 20.2 Update `structure.md` and `tech.md` steering docs
    - Update `structure.md` to the real foundation layout (`app/`, `components/`, `lib/`,
      `supabase/`, `public/`, `.env.example`) so every documented directory exists and every
      top-level source directory is documented (bidirectional consistency); update `tech.md`
      to reflect the locked stack
    - _Requirements: 2.3_

  - [ ]* 20.3 Write the structure.md consistency check
    - A check that every directory named in `structure.md` exists in the repo and every
      top-level source directory is listed in `structure.md`
    - _Requirements: 2.3_

- [ ] 21. Final checkpoint - ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. All test sub-tasks,
  the environment-dependent integration/smoke tasks (18, 19), and the manual documentation
  write-ups (20.1, 20.3) are marked optional.
- Tasks 18 and 19 require a running Supabase/Postgres instance and a deployed baseline;
  treat them as environment-dependent verification rather than pure-code steps.
- Task 20.1 (Hosting_Decision_Record) and 20.3 (structure consistency) are documentation /
  manual-verification artifacts; 20.2 is a required doc update because the scaffold changes
  the real layout.
- Each of Properties 1–15 is implemented as exactly one fast-check property test (min 100
  iterations), tagged `Feature: web-app-foundation, Property {number}: {property_text}`, and
  placed next to the code it validates so failures surface early.
- For P3, P4, P6, P7, and P14 the pure predicate/model is property-tested here; the
  database-backed guarantees (constraints, RLS, transactional rollback, sequence locking) are
  additionally exercised by the integration tests in Task 18.
- Requirement 3.15 is vacuously satisfied: the resolved Identity_Model is session-based, so
  no persistent cross-game identity records are created.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "4.2", "4.3", "5.2", "7.1"] },
    { "id": 3, "tasks": ["7.2", "7.3", "7.6", "7.7", "8.1"] },
    { "id": 4, "tasks": ["7.4", "8.2", "9.1", "11.1"] },
    { "id": 5, "tasks": ["7.5", "9.2", "9.3", "10.1"] },
    { "id": 6, "tasks": ["10.2", "10.3", "13.1"] },
    { "id": 7, "tasks": ["10.4", "13.2"] },
    { "id": 8, "tasks": ["13.3", "13.4", "13.5", "14.1", "14.2"] },
    { "id": 9, "tasks": ["14.3", "14.4", "15.1", "16.1", "16.2"] },
    { "id": 10, "tasks": ["16.3", "18.1", "18.2", "18.3", "18.4", "18.5"] },
    { "id": 11, "tasks": ["19.1", "19.2", "19.3", "19.4", "19.5", "20.1", "20.2"] },
    { "id": 12, "tasks": ["20.3"] }
  ]
}
```
