# Map And Claiming Tasks

## Purpose

This is the execution plan for roadmap section 2: candidate-bar map completion, durable reversible claims, live score recomputation, finish-bar game ending, and board UI wiring.

### Working rules

- Every successful domain mutation writes its state changes and canonical events in one transaction.
- Rejected mutations write nothing and return a stable error.
- The claim tap is the MVP honor-system attestation for presence and drink completion.
- Server state and committed events are authoritative; the browser does not maintain durable claim state optimistically.
- `game_events` is the realtime propagation and audit log. Durable claims and score ledger rows remain authoritative current state.
- Each behavior change adds focused pure, route, database, reducer, component, or integration coverage before the next dependent task.

## Phase 0: Existing map baseline

- [x] 0.1 Confirm the candidate-bar map surface
  - Verify `lib/map/bars.ts` contains the stable in-house candidate catalog and coordinates.
  - Verify `BarLeafletMap` renders every candidate marker and fits the initial viewport to catalog bounds.
  - Verify pan, zoom, marker popups, team color segmentation, and current-team claim/unclaim controls.
  - Keep this baseline compatible with the later server-backed claim contract.

- [ ] 0.2 Record the focused baseline
  - Run the existing map, board, scoreboard, viewport, and property suites.
  - Run `npm run typecheck` and `npm run lint`.
  - Record unrelated failures or Supabase environment limitations before durable claim work begins.
  - Done when the baseline is green or failures are explicitly classified.

## Phase 1: Claim and ledger persistence

- [x] 1.1 Resolve implementation contracts
  - Record the trusted claim-time attestation for all-member presence and the `ceil(team size / 2)` threshold.
  - Record reversible active/revoked claim behavior for ordinary undo and Voted Off the Island.
  - Record that finish-bar claims cannot be undone after game end.
  - Record append-only score adjustment entries and deterministic current totals.

- [x] 1.2 Evolve the claims schema
  - Add active/revoked lifecycle representation while retaining historical claim transitions.
  - Enforce at most one active claim for a game/team/bar pair.
  - Allow a revoked claim to be followed by a new active claim.
  - Preserve same-game team and bar foreign-key guarantees.
  - Add indexes for active claims by game, bar, and team.
  - Update schema and migration tests.

- [x] 1.3 Add the score adjustment ledger
  - Add durable game/team/bar/source references, category, signed points, server timestamp, and explanation metadata.
  - Add constraints proving ledger rows belong to the same game as their team/bar/source claim.
  - Add indexes for game totals, team totals, and source transitions.
  - Add RLS for game-member reads and server-only writes.
  - Add schema, migration, and cross-game isolation coverage.

- [x] 1.4 Checkpoint: persistence foundation
  - Migrations apply cleanly to a disposable database.
  - Active-claim uniqueness and revoke/reclaim behavior are enforced.
  - Ledger rows cannot cross game boundaries.
  - Client writes are rejected where server-only mutation is required.
  - Offline and live migration smoke tests pass, and the live claims/ledger RLS
    integration suite passes against the configured Supabase project.

## Phase 2: Pure claim and scoring domain

- [x] 2.1 Implement claim eligibility and lifecycle transitions
  - Add pure functions for assigned team membership, half-team threshold, claim eligibility, duplicate claim, authorized undo, revoke, and reclaim.
  - Exclude teamless players from the team count.
  - Reject empty teams and invalid team sizes.
  - Return stable domain outcomes rather than route-specific errors.

- [x] 2.2 Implement score ledger delta calculations
  - Preserve the existing 12-point split table for one through four active claimers.
  - Recompute affected teams whenever a claim is added or revoked.
  - Keep start-bar score at zero.
  - Award finish-bar 12 points to the claiming team only.
  - Produce signed append-only adjustments whose net totals equal the current active claim state.

- [x] 2.3 Add pure property coverage
  - Cover odd and even team sizes, including 2 of 3 qualifying and 1 of 3 failing.
  - Cover 2, 3, and 4 active claimers and conservation of the 12-point bar total.
  - Cover duplicate requests, ordinary undo, Voted Off-compatible revoke/reclaim, and stale transitions.
  - Cover start and finish bar special cases.
  - Cover repeated application and deterministic output.

## Phase 3: Atomic claim route and finish behavior

- [x] 3.1 Add the claim mutation route
  - Add `app/api/games/[gameId]/claims/route.ts`.
  - Reuse `requireSession`, membership assertions, locked game reads, `withTransaction`, and stable route response patterns.
  - Accept explicit `claim` and `unclaim` actions plus a bar id.
  - Derive the acting player and team from the session; never trust a client-supplied team id.

- [x] 3.2 Implement successful ordinary claims
  - Require an active game and same-game bar.
  - Resolve current team membership and apply the trusted half-team/presence contract.
  - Evaluate the active claim state under the game/bar lock.
  - Insert the active claim transition.
  - Append score ledger adjustments and canonical claim/score events.
  - Return the committed sequence and result.

- [x] 3.3 Implement successful unclaims and reclaims
  - Allow only the owning team to undo its active claim.
  - Revoke the claim with a reason/source.
  - Append inverse or recomputed ledger adjustments and `claim_removed`.
  - Allow a later claim to create a new active transition.
  - Reject unclaiming finish claims and claims after game end.

- [x] 3.4 Implement finish-bar claim ending
  - Lock the game row before lifecycle evaluation.
  - Award the solo 12 points and append the finish claim and score events.
  - Transition `live` to `ended` with `finish_bar_claimed`.
  - Record the claiming team as the event actor.
  - Ensure competing finish requests cannot double-award or double-end.

- [x] 3.5 Add route and transaction coverage
  - Half-team accepted and rejected.
  - Teamless players excluded from the threshold.
  - Duplicate active claim conflict.
  - Unauthorized team unclaim rejected.
  - Revoke/reclaim success.
  - Start-bar zero score.
  - Ordinary share corrections for late claimers and removals.
  - Finish-bar award and lifecycle transition.
  - Append-event failure rolls back claim, ledger, and lifecycle state.
  - Finish-claim race produces one winner and one conflict.

- [x] 3.6 Checkpoint: server-owned claim loop
  - A browser session can claim and undo a bar through the route.
  - Durable state, ledger state, and events commit or roll back together.
  - A finish claim ends the game exactly once.
  - No browser path directly mutates claims or scores.

## Phase 4: Board reducer and realtime state

- [x] 4.1 Extend `GameBoardView`
  - Add active claims grouped by bar and team.
  - Add score totals and claimed-bar counts, or deterministic selectors for them.
  - Preserve current lifecycle, team, card, notification, and sequence fields.

- [x] 4.2 Fold claim events
  - Apply `claim_recorded` to active claim state.
  - Apply `claim_removed` to remove only the specified active transition.
  - Support later reclaims without resurrecting revoked history.
  - Ignore stale/duplicate and foreign-game events.

- [x] 4.3 Fold score events
  - Apply score entries idempotently.
  - Derive totals from the ledger/event entries without double-counting corrections.
  - Preserve score category and source information for future explanations.

- [x] 4.4 Add reducer and realtime coverage
  - Snapshot hydration with claims and scores.
  - Ordered live claim and score events.
  - Duplicate and out-of-order delivery.
  - Reconnect/resume catch-up.
  - Cross-game event isolation.
  - Finish event lifecycle rendering.

- [x] 4.5 Checkpoint: equivalent client state
  - Folding a complete snapshot and applying the same ordered realtime tail produce equivalent claims, scores, and lifecycle.
  - A second client receives marker and scoreboard changes without navigation or reload.

## Phase 5: Durable map and scoreboard UI

- [ ] 5.1 Replace local map claim state
  - Remove authoritative `useState` claim ownership from `MapRegion`.
  - Pass reducer-derived claim state and a mutation callback from the board page.
  - Preserve map region navigation and candidate catalog behavior.

- [ ] 5.2 Wire popup claim actions
  - Call the claim route with the selected bar and explicit action.
  - Allow only the current player's team to mutate its own claim.
  - Show pending, disabled, conflict, and failure states.
  - Do not leave a durable-looking optimistic state after a failed request.
  - Render all active claimant colors from reducer state.

- [ ] 5.3 Wire live scoreboard values
  - Pass live team totals and active claimed-bar counts to `ScoreboardRegion`.
  - Render zero values explicitly.
  - Update totals and counts from realtime events without remounting.
  - Preserve responsive layout, team colors, touch targets, and accessibility.

- [ ] 5.4 Add UI and page tests
  - Popup claim/unclaim request behavior.
  - Failed mutation leaves state unchanged.
  - Pending controls prevent duplicate submissions.
  - Marker segments update for one through four active teams.
  - Scoreboard renders varied totals and claimed-bar counts.
  - Board snapshot hydrates map and scoreboard before subscription completion.
  - Live claim, removal, score, and game-ended events update the rendered region.

## Phase 6: End-to-end verification

- [ ] 6.1 Run focused suites
  - `lib/claims` and `lib/scoring` properties.
  - Claims route tests.
  - Schema, migration, RLS, and database integration tests.
  - Board reducer and realtime tests.
  - Map, scoreboard, and board page component/viewport tests.

- [ ] 6.2 Run repository checks
  - `npm run typecheck`.
  - `npm run lint`.
  - Full Vitest suite.
  - Record unrelated warnings or failures without expanding this feature's scope.

- [ ] 6.3 Run configured Supabase checks
  - Apply the new migration set to the configured project.
  - Verify claim/score event propagation across two sessions.
  - Verify cross-game isolation and reconnect catch-up.
  - Record environment/infrastructure blockers separately from local failures.

- [ ] 6.4 Browser acceptance flow
  - Start a live game with two sessions.
  - Claim an ordinary bar from one session and observe the other session's marker and scoreboard.
  - Add a second claimant and verify share recomputation.
  - Undo and re-claim a bar.
  - Claim the finish bar and verify the ended state and final score display.

- [ ] 6.5 Update roadmap status
  - Mark F2.1, F2.2, and F2.3 according to the actually completed backend and UI work.
  - Record any deferred card restriction hooks or environment limitations.
  - Link this spec from `ROADMAP.md` if that convention is adopted.
