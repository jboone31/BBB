# Implementation Plan: card-behavior

## Overview

Implements downstream behavior for all 23 Brawl Deck cards in TypeScript, following
`design.md`: pure planners in `lib/` decide every rule, thin routes lock the game, read
`clock_timestamp()`, lazily settle due effect transitions, load a `BehaviorState`, call the
planner, write the plan, and append events with embedded records. The order is: card text
and metadata, pure foundation modules, rule planners (including the single Legal_Next_Bar
rule), migrations 0013 and 0014, server persistence and the lazy settle step, player
routes, projection, toasts, Boundary_Toasts and the Realtime recheck, board UI, host
overrides, timer settlement (Settle_Nudge, optional Cron_Route, board timers), the oracle
and steering doc updates, and final verification. There is no database scheduler: the
settle function runs only when a board nudges it, a mutation settles lazily, or the
optional Cron_Route is called.

`npm test` stays hermetic (fake `QueryRunner` route tests, pure property tests). Live
database and Realtime checks live only under `supabase/__tests__/integration` and run with
`npm run test:integration`.

## Tasks

- [x] 1. Finalized card text and catalog metadata
  - [x] 1.1 Create `lib/cards/cardText.ts` and reshape the catalog
    - Define `TemplatePlaceholder`, `CardToastOverrides`, `CardText` (`requires`, `effect`, `targetNote`, `targetToastBody`, optional `toasts`), `createCardText` (throws at module load on blank `effect`/`targetNote`, or blank `targetToastBody` for team-target cards), and `getCardText`
    - Copy every card's Requires, Effect, Target, target toast body, and per-card toast overrides (announcement, othersBody, start, end, payout, mirror headlines, Fairest prompt "Play FAIREST OF THEM ALL to make {Caster} complete this challenge too?", Everyone's a Critic actions) from `docs/card-text-oracle.md`, joining line wraps with single spaces; omit the Challenge_Gate rule from all copy
    - In `lib/cards/catalog.ts`: remove `placeholderCardText`, `description`, `castingRequirement`, `targetRequirement`; re-export `getCardText`; set Happy Hour `resolution: "none"`, `completionRequired: false`; set Pioneer and Scenic Route `completionRequired: false`; add `isGatedCard(meta)` and `isMirrorableCard(meta)`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 3.10_

  - [x] 1.2 Migrate consumers of the old card-text fields
    - Update `components/board/CardsRegion.tsx`, `components/board/CardPlayPanel.tsx`, and `lib/cards/catalog.test.ts` to the new fields
    - CardsRegion inspection renders Requires (when present), then Effect, then Target note
    - Add a catalog test asserting the metadata-derived Gated_Card set equals the Glossary list and the Mirrorable set equals Gated plus Pioneer and Scenic Route
    - _Requirements: 1.5, 1.6, 1.7_

  - [x] 1.3 Write property test for card text validation
    - **Property 1: Card text validation**
    - File `lib/cards/cardText.property.test.ts`
    - **Validates: Requirements 1.3, 1.4**

  - [x] 1.4 Write the oracle parity test
    - `lib/cards/cardText.oracle.test.ts` parses `docs/card-text-oracle.md` sections and compares every field of every card character for character (apart from placeholders); also asserts every placeholder in every string belongs to the allowed set
    - Match field labels by prefix (e.g. `Prompt`) so the 13.1 relabel of the Fairest prompt line does not break parsing
    - _Requirements: 1.2, 24.3_

  - [x] 1.5 Create `lib/cards/templates.ts` and `lib/cards/clockOffset.ts`
    - `renderTemplate` (single-pass, no re-expansion, unknown placeholders left in place), `templatePlaceholders`, `formatDuration` (`m:ss`), `parseDuration`, `formatClockTime` (`h:mm AM/PM` in the viewer time zone), `remainingMs` (clamped at 0)
    - `clockOffset.ts` (pure): `measureOffset(sentAtMs, receivedAtMs, serverNowIso)` = `Date.parse(serverNow) - (sentAtMs + (receivedAtMs - sentAtMs) / 2)`; `serverNow(deviceNowMs, offsetMs)` = `deviceNow + offset`
    - _Requirements: 1.3, 3.5, 3.6, 20.7, 20.9_

  - [x] 1.6 Write property test for template rendering
    - **Property 2: Template rendering fills every value exactly once**
    - File `lib/cards/templates.render.property.test.ts`; include values containing brace tokens
    - **Validates: Requirements 1.3, 3.5, 9.6**

  - [x] 1.7 Write property test for duration and time formatting
    - **Property 3: Duration and time formatting**
    - File `lib/cards/templates.format.property.test.ts`; also covers `measureOffset`: for any server stamp inside the round trip, the offset error is at most half the round trip
    - **Validates: Requirements 3.6, 20.7, 20.9**

- [x] 2. Pure foundation modules
  - [x] 2.1 Create `lib/cards/inputs.ts`
    - `ROYGBIV`, `CastingParams`, `validateCastingInput`: exactly three distinct ROYGBIV colors (case-insensitive, lowercased, order preserved), integer seconds in [0, 300], cuisine trimmed to 1-60 characters; otherwise `invalid_input`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 2.2 Write property test for casting input validation
    - **Property 10: Casting input validation**
    - File `lib/cards/inputs.property.test.ts`
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x] 2.3 Create `lib/map/geo.ts`
    - `LatLng`, `EARTH_RADIUS_MILES`, `CANCEL_CULTURE_RADIUS_MILES = 0.25`, `haversineMiles`, `withinMiles` (inclusive `<=`), `parseBarLocation("lat,lng")`
    - _Requirements: 10.4, 12.1, 12.4_

  - [x] 2.4 Write property test for geodesic distance
    - **Property 14: Geodesic distance is a metric and radius membership is consistent**
    - File `lib/map/geo.property.test.ts`; generators mix `CANDIDATE_BARS` coordinates with random coordinates
    - **Validates: Requirements 10.4, 12.1, 12.4**

  - [x] 2.5 Create effect windows and transitions in `lib/cards/effects.ts`
    - `EffectKind`, `EffectRecord`, `DURATIONS_MS`, `effectPhase`, `isEffectActive` (`startsAt <= t < endsAt`, not cancelled/consumed at or before t), `drawOverrideActive` (union of active Power Hour windows)
    - `planEffectTransitions(effects, nowMs, lifecycle)`: live games only; activation due when unannounced, started, not cancelled before start; expiry due when unannounced, ended, not consumed, not cancelled before end; activation before expiry; ordered by `atMs` then `effectId`
    - Boundary_Toast schedule: `BoundaryKind`, `Boundary`, `toastBoundaries(effects)` (start: Cancel Culture `radius_lock` only; end: `bar_lock`, `radius_lock`, `bonus_window`, `draw_override` with a non-null `endsAt` not cancelled or consumed at or before `endsAt`, so host and game-end cancellations get no end toast), and `nextBoundaryAfter(effects, serverNowMs)`
    - _Requirements: 3.7, 12.6, 17.3, 20.1, 20.2, 20.3a, 20.3b, 20.3c, 20.4, 20.6_

  - [x] 2.6 Write property test for effect windows
    - **Property 13: Effect windows follow server time**
    - File `lib/cards/effects.property.test.ts`; times at `boundary ± 1 ms`, overlapping Power Hour sets
    - **Validates: Requirements 11.2, 12.3, 13.2, 17.1, 17.3, 20.1, 20.2, 21.4**

  - [x] 2.7 Write property test for timer settlement planning
    - **Property 22: Timer settlement announces each transition exactly once, by the next call**
    - File `lib/cards/effects.transitions.property.test.ts`; model interleavings at nondecreasing server times of Settle_Nudge calls, Card_Behavior_Mutations (accepted or rejected, each settling at its own `now` before its plan), and Cron_Route calls, with no scheduler-driven calls; mark announced flags between calls; assert transition events precede the mutation's own events, exactly one mutation event per accepted mutation and zero per rejection, and that flipping announced flags changes no block, eligibility, or bonus decision
    - **Validates: Requirements 19.6, 19.9, 19.10, 20.3b, 20.3c, 20.4, 20.5c, 20.6**

  - [x] 2.8 Create `lib/scoring/allocation.ts`
    - `SHARE_CATEGORIES`, `AWARD_CATEGORIES`, `computeBarAllocation` (start 0; finish 12 to single claimant; scoring `12 / (n + phantom&&n<4 ? 1 : 0)`; protected claimants get `max(base, floor)`), `currentBarHoldings` (share categories only), `reconcileBar` (`bar_share` for zero prior holdings, else `bar_share_correction`, sorted by team id)
    - Re-implement `computeShareAdjustments` in `lib/scoring/index.ts` as a thin wrapper (no phantom, no floors) so existing scoring tests keep passing
    - _Requirements: 13.8, 14.2, 14.3, 15.3, 15.4, 16.5_

  - [x] 2.9 Write property test for share allocation
    - **Property 16: Share allocation rule**
    - File `lib/scoring/allocation.property.test.ts`
    - **Validates: Requirements 14.2, 14.3, 15.3, 15.4**

  - [x] 2.10 Write property test for ledger reconciliation
    - **Property 17: Ledger reconciliation preserves allocations and awards**
    - File `lib/scoring/allocation.reconcile.property.test.ts`; step sequences of claims, unclaims, Voted Off removals, Party Crasher, Insurance attach/release, and host endings, interleaved with award entries
    - **Validates: Requirements 13.8, 14.4, 14.5, 14.6, 15.5, 16.5, 18.4, 18.7, 21.5, 21.6**

  - [x] 2.11 Add the Power Hour keep-all draw mode to `lib/cards/deck.ts`
    - Add `DeckState.pendingMode: "choose_one" | "keep_all"`; `drawForBar(state, barId, { finishBar, drawOverride })` sends cards to hand when room exists, else pending with `keep_all`
    - `keepCard` in `keep_all` moves only the chosen card and rejects `hand_full`; pending `discardCard` discards only that card; `forfeitDraw` discards all pending; remove `powerHourUntil` / `activatePowerHour`
    - Update `lib/cards/deck.test.ts` and existing deck property tests for the new signature
    - _Requirements: 17.2_

  - [x] 2.12 Write property test for Power Hour draws
    - **Property 20: Power Hour draws keep every card within the hand limit**
    - File `lib/cards/deck.powerHour.property.test.ts`
    - **Validates: Requirements 17.2**

- [x] 3. Rule planners
  - [x] 3.1 Define shared behavior types in `lib/cards/behaviorState.ts`
    - Type-only, framework-free: `StableError`, `Plan<T>`, `ChallengeStatus`, `ChallengeRecord`, `FairestOfferStatus`, `FairestOfferRecord`, `AwardRecord`, `ClaimRow`, `PlayRow`, `ResolvedBarRef`, `InventoryFollowUp`, and `BehaviorState` exactly as in the design; `challenges.ts` and (later) `behaviorStore.ts` re-export them
    - _Requirements: 4.6, 19.8_

  - [x] 3.2 Create the challenge state machine in `lib/cards/challenges.ts`
    - `resolveChallenge` per the transition table (`not_authorized`, `already_resolved`, `conflict` for a live Fairest offer, `fail` only for Everyone's a Critic creating a `team_claim_block` `[now, now+15m)`), recording resolving session, team, time, and kind
    - `decideFairest` Play re-check: for a Pioneer or Scenic Route offer, after the in-hand (`conflict`) and pending (`already_resolved`) checks, re-run `mirrorIsLegal(state, offer, now)` from 3.17 at the decision's `now`; when false reject with `invalid_input`, details `{ reason: "no_legal_next_bar", rules }`, write nothing, and leave the offer `pending` so Decline stays available
    - `decideFairest` (decline; play requires Fairest still in hand, moves it to played, creates the Mirrored_Challenge or mirrored `next_claim_restriction` on the original caster with the same slug and params, voids the holder's other pending offers, leaves the original untouched; mirrored UIOLI created `completed` when the caster's hand and pending are empty)
    - `hostChallengeOverride` (clear `open` → `cleared_by_host` voiding its pending offer; reset `completed`/`failed` → `open` cancelling the critic `failureEffectId`; reject UIOLI reset with an empty hand and no pending draw, and reset of `cleared_by_host`, with `conflict`)
    - `useItOrLoseItShouldComplete`, `settleInventoryChange` (UIOLI auto-completion with `resolvedByKind: "system"`, offers voided when Fairest leaves the hand)
    - `checkCannotPlayDiscard(state, teamId)`: `conflict` when the team's open UIOLI challenge has a pending Fairest offer
    - "Pending offer" = `pending` offer whose holder still holds Fairest
    - _Requirements: 4.4, 4.6, 5.2, 5.3, 5.4, 5.5, 7.2, 7.4, 8.5, 8.7, 9.3, 9.4, 9.5, 9.8, 9.9, 9.10, 9.12, 9.13, 9.16, 9.17, 21.1, 21.2, 21.3_

  - [x] 3.3 Write property test for the challenge state machine
    - **Property 9: Challenge state machine**
    - File `lib/cards/challenges.property.test.ts`; arbitrary actors and orders, including host clear/reset (UIOLI reset with empty hand → `conflict`), `checkCannotPlayDiscard` under a live offer, and the gate iff-open check
    - **Validates: Requirements 4.4, 4.6, 5.2, 5.3, 5.4, 5.5, 7.2, 7.4, 9.4, 21.1, 21.2, 21.3**

  - [x] 3.4 Write property test for Use It or Lose It completion
    - **Property 11: Use It or Lose It completes exactly when the hand clears**
    - File `lib/cards/challenges.uioli.property.test.ts`
    - **Validates: Requirements 8.1, 8.5, 8.6, 8.7**

  - [x] 3.5 Create `lib/claims/blocks.ts`
    - `ClaimBlock`, `ClaimBlockInput`, `evaluateClaimBlocks` collecting (not short-circuiting) in order: challenge gate, critic block, Crop Dusting (owner exempt), Cancel Culture (every team, inclusive 0.25 mi, uncoordinated bars never blocked), and in `claim` mode only Pioneer (`finish_bar`, `claimed_by_other`) and Scenic Route (`not_farther`, `no_coordinates`); timed blocks carry `endsAt`
    - Decide Pioneer `claimed_by_other` and Scenic `not_farther` with `barSatisfiesRule` from `lib/claims/legalNextBar.ts` (3.17) so restriction blocks and Legal_Next_Bar never disagree; only uncancelled, unconsumed restrictions apply, so a host-ended restriction stops blocking
    - Blocks are evaluated against the server `nowMs` passed in, never against announced flags, so they hold whether or not transition events exist
    - Re-export `previousBarFor` (defined in `legalNextBar.ts` to avoid a circular import; latest claim not revoked as `ordinary_unclaim`, else start bar)
    - _Requirements: 4.2, 4.3, 7.3, 10.2, 10.4, 10.5, 10.7, 11.3, 12.4, 19.1, 19.3, 20.3c, 21.11_

  - [x] 3.6 Write property test for claim block evaluation
    - **Property 6: Claim block evaluation is complete and exact**
    - File `lib/claims/blocks.property.test.ts`
    - **Validates: Requirements 4.2, 4.3, 7.3, 11.3, 12.4, 19.1, 19.3, 10.7**

  - [x] 3.7 Write property test for next-claim restriction semantics
    - **Property 7: Next-claim restriction semantics**
    - File `lib/claims/blocks.restrictions.property.test.ts`
    - **Validates: Requirements 10.2, 10.4, 10.5**

  - [x] 3.8 Create `lib/cards/claimEffects.ts`
    - `planClaimSideEffects`: consume every `next_claim_restriction` for the team; attach the oldest pending Insurance with `protectedPoints` equal to the post-claim allocation; +5 for each active `bonus_window` on the bar with no unreversed award; Patient Investor counting of distinct bar keys with +6 payout and consumption at 4 (including the finish bar); `drawOverride = drawOverrideActive(...)`
    - `planUnclaimSideEffects`: ordinary unclaim reverses Happy Hour awards from the claim (−5), uncounts unpaid counters, releases attached protection; `voted_off` only releases protection
    - `planBonusClaim(state, teamId, barKey, nowMs)`: live game, active claim on the bar (`conflict`), a `bonus_window` on the bar (`not_found`), window active at server `nowMs` (`expired`), no unreversed award (`already_resolved`), no `evaluateClaimBlocks(mode: "bonus")` blocks (`blocked`); never consumes restrictions, Insurance, or counters
    - _Requirements: 10.6, 10.7, 13.3, 13.5, 13.6, 13.7, 13.9, 15.1, 15.2, 15.5, 15.6, 16.2, 16.3, 16.4, 16.7, 17.2, 18.7, 20.3c_

  - [x] 3.9 Write property test for next-claim consumption
    - **Property 8: Next-claim effects are consumed by exactly the next real claim**
    - File `lib/cards/claimEffects.nextClaim.property.test.ts`
    - **Validates: Requirements 10.6, 10.7, 15.1, 15.2, 15.6**

  - [x] 3.10 Write property test for Happy Hour bonus uniqueness
    - **Property 18: Happy Hour bonus uniqueness**
    - File `lib/cards/claimEffects.happyHour.property.test.ts`
    - **Validates: Requirements 13.3, 13.5, 13.6, 13.7, 13.9**

  - [x] 3.11 Write property test for Patient Investor counting
    - **Property 19: Patient Investor counts distinct subsequent claims**
    - File `lib/cards/claimEffects.patientInvestor.property.test.ts`
    - **Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.7, 21.6**

  - [x] 3.12 Extend target eligibility in `lib/gameboard/cardEligibility.ts`
    - Add `CardTargetContext` and the extended `BarIneligibilityReason` set; `selectBarTargetEligibility` enforces finish bar (Crop Dusting, Happy Hour, Party Crasher), `near_finish` / `no_coordinates` (Cancel Culture), `four_claimants` (Party Crasher), `start_bar` / `not_claimed_by_all` (Voted Off), and the existing same-card bar rule
    - `selectTeamTargetEligibility` excludes the caster and applies the same-name rule counting only `card_played` facts (mirrors excluded)
    - `CardTargetContext` gains `previousBars` and `restrictions` (unconsumed, uncancelled `next_claim_restriction` rules per team); for Pioneer and Scenic Route a team is ineligible with reason `no_legal_next_bar` and the `rules` involved when `hasLegalNextBar(team, its rules ∪ {played rule})` (3.17) is false, covering Pioneer/Scenic stacking
    - Update `cardEligibility.test.ts`
    - _Requirements: 9.14, 10.10, 10.11, 10.12, 11.1, 12.1, 12.2, 13.1, 14.1, 18.1, 18.2, 18.3, 22.1, 22.5_

  - [x] 3.13 Create the card-play planner in `lib/cards/playPlan.ts`
    - `PlayRequest`, `PlayPlan`, `planCardPlay` with validation order: live (`conflict`), card in hand (`conflict`), Fairest via play (`invalid_input`), casting input, target mode, target eligibility via the 3.12 selectors (`invalid_input`), then the per-card resolver registry
    - Resolvers per the design table: gated team cards (open challenge; UIOLI `completed` when target hand and pending are empty; offer when target holds Fairest and play is not a mirror), Pioneer/Scenic restrictions plus offers, Crop Dusting `bar_lock`, Cancel Culture `radius_lock` `[now+15m, now+30m)`, Happy Hour `bonus_window`, Party Crasher `phantom_share` plus reconcile, Insurance, Patient Investor (`counted: []`), Power Hour `draw_override`, Voted Off (revoke target claim `voted_off`, release attached Insurance, reconcile, no challenge)
    - Pioneer / Scenic Route: a target with no Legal_Next_Bar for its active rules plus the new rule is rejected with `invalid_input`, details `{ reason: "no_legal_next_bar", rules }`, and the card stays in the caster's hand (same reason the 3.12 selector reports)
    - Pioneer / Scenic Route Fairest offer is created only when the target holds Fairest, the play is not a mirror, **and** `mirrorIsLegal` (3.17) holds for the original caster at the play's `now`; otherwise the play succeeds with no offer
    - Insurance, Patient Investor, and Power Hour accept no target; store validated params on the play and challenge
    - _Requirements: 4.1, 6.4, 6.5, 8.1, 8.6, 9.1, 9.11, 9.14, 9.15, 10.1, 10.3, 10.10, 10.11, 11.1, 11.2, 12.1, 12.3, 13.1, 13.2, 14.1, 14.4, 14.6, 15.1, 16.1, 17.1, 18.2, 18.4, 18.5, 22.1, 22.2, 22.3, 22.4, 22.5_

  - [x] 3.14 Write property test for Fairest offers and mirrors
    - **Property 12: Fairest offers and mirrors**
    - File `lib/cards/playPlan.fairest.property.test.ts`; include Pioneer/Scenic plays where `mirrorIsLegal` is false at the play's server time (no offer, play still succeeds)
    - Required by 24.7 (Fairest mirror check)
    - **Validates: Requirements 6.5, 9.1, 9.5, 9.8, 9.9, 9.10, 9.13, 9.14, 9.15**

  - [x] 3.15 Write property test for target eligibility parity
    - **Property 15: Target eligibility parity between UI and server**
    - File `lib/cards/playPlan.eligibility.property.test.ts`; include Pioneer/Scenic targets with no Legal_Next_Bar (single and stacked rules), asserting the same `no_legal_next_bar` reason on both sides
    - Required by 24.7 (Legal_Next_Bar guard)
    - **Validates: Requirements 10.12, 11.1, 12.1, 12.2, 13.1, 14.1, 18.1, 18.2, 18.3, 22.1, 22.2, 22.5**

  - [x] 3.16 Write property test for Voted Off the Island
    - **Property 21: Voted Off the Island removes one claim without gating**
    - File `lib/cards/playPlan.votedOff.property.test.ts`
    - **Validates: Requirements 18.4, 18.5, 18.6**

  - [x] 3.17 Create `lib/claims/legalNextBar.ts`
    - Implement after 3.1 and before 3.2, 3.5, 3.12, and 3.13 (see the dependency graph); it is the only definition of Legal_Next_Bar
    - `NextClaimRule`, `LegalNextBarInput`, `barSatisfiesRule` (pioneer: no other team holds an active claim on the bar; scenic: bar, finish, and previous-bar coordinates known and `haversine(bar, finish) > haversine(previousBar, finish)`)
    - `selectLegalNextBars` (sorted bar keys: non-finish, not actively claimed by the team, satisfies every rule; rules treated as a set; temporary locks and the Challenge_Gate ignored; start bar is an ordinary candidate), `hasLegalNextBar`
    - `mirrorIsLegal(state, offer, now)`: true for non-restriction slugs; for Pioneer/Scenic, `hasLegalNextBar(originalCaster, caster's active rules ∪ {offer's rule})`; active rules exclude consumed and cancelled (including host-ended) restrictions
    - `previousBarFor(teamId, claimHistory, startBar)` lives here and is re-exported by `blocks.ts`
    - _Requirements: 9.15, 9.16, 9.17, 10.5, 10.10, 10.11, 10.12, 21.11, 22.5_

  - [x] 3.18 Write property test for the Legal_Next_Bar guard
    - **Property 24: Legal_Next_Bar guard is one rule shared by plays, blocks, and mirrors**
    - File `lib/claims/legalNextBar.property.test.ts`
    - Checks: stacking Pioneer and Scenic is legal iff one bar satisfies both; duplicate rules are no stricter than one; empty rules make every non-finish, unheld bar legal and temporary locks never change the result; `b ∈ selectLegalNextBars` iff b is non-finish, unheld, and `evaluateClaimBlocks(mode: "claim")` returns no `pioneer` / `scenic` block for it; `mirrorIsLegal` equals `hasLegalNextBar` on the caster's active rules plus the offer's rule
    - Required by 24.7 (Legal_Next_Bar guard, stacking, and Fairest mirror check)
    - **Validates: Requirements 9.15, 9.16, 10.10, 10.11, 22.5**
    - _Requirements: 24.7_

- [x] 4. Checkpoint - pure modules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Migration 0013
  - [x] 5.1 Write `supabase/migrations/0013_card_behavior.sql`
    - One begin/commit: `claims_revoked_reason_valid`; `card_plays` slug/target bar/params columns and constraints; `team_decks.pending_mode`; tables `card_challenges`, `card_effects`, `fairest_offers`, `card_effect_awards` with the design's constraints and indexes; `score_ledger_entries.source_effect_id` FK; partial unique index `game_events_effect_transition_once`; member-select RLS and revoked client writes on the new tables
    - _Requirements: 4.1, 4.6, 6.5, 13.6, 18.4, 20.4, 23.1_

  - [x] 5.2 Update `scripts/verify-schema.mjs` expectations for the new tables, columns, constraints, and indexes
    - _Requirements: 4.1, 20.4_

  - [x] 5.3 Write integration test for migration 0013
    - `supabase/__tests__/integration/cardBehaviorSchema.integration.test.ts`: migration applies; check constraints, the one-live-award index, and the duplicate-transition index reject bad rows
    - _Requirements: 13.6, 20.4, 24.4_

- [x] 6. Server persistence
  - [x] 6.1 Adopt the Stable_Error vocabulary in `app/api/games/_shared.ts`
    - Add `not_authorized` 403, `invalid_input` 400, `conflict` 409, `blocked` 409, `expired` 409, `already_resolved` 409, `unavailable` 503 to `LobbyErrorReason` / `ERROR_STATUS`; `notApplied(reason, details?)`; success envelope `{ applied: true, seq, result? }`; uncaught errors respond `unavailable` (503)
    - _Requirements: 19.5, 19.8_

  - [x] 6.2 Create `lib/map/barResolver.ts`
    - `ResolvedBar`, `resolveGameBar(tx, gameId, key)`: match by uuid, then by the exported TypeScript `slug()` from `lib/map/bars.ts`, materialize a candidate bar on first touch, resolve coords from `bars.location` or `CANDIDATE_BARS`; all event payloads use `barKey`
    - _Requirements: 10.4, 12.1, 12.4_

  - [x] 6.3 Create `lib/cards/behaviorStore.ts`
    - `loadBehaviorState`, `writeChallenges`, `writeOffers`, `writeEffects` (idempotent `on conflict (id) do update`; immediate-start effects inserted with `start_announced_at = created_at`), `appendLedger` (with `source_effect_id`), `reconcileBarsInTx` (phantom and Insurance floors), `endGameEffects` (`cancel_reason = 'game_ended'`); re-export the 3.1 types
    - _Requirements: 4.1, 19.4, 19.7, 20.1, 20.6_

  - [x] 6.4 Extend `lib/cards/persistence.ts`
    - Export `instanceRowId`; `persistDeckTransition` accepts `eventExtra` to merge `InventoryFollowUp` records (UIOLI completion, voided offers) into the single inventory event; persist `team_decks.pending_mode`
    - _Requirements: 8.3, 8.5, 9.12, 17.2_

  - [x] 6.5 Call `endGameEffects` from `endGame` in `lib/gameend/transition.ts` before its single `game_ended` append
    - _Requirements: 20.6_

  - [x] 6.6 Write unit tests for `behaviorStore.ts` with a fake `QueryRunner`
    - Load shape, idempotent upserts, reconciliation writes, game-end cancellation
    - _Requirements: 19.4, 20.6_

  - [x] 6.7 Add the lazy settle step to the Card_Behavior_Mutation pipeline
    - In `lib/cards/behaviorStore.ts` add `settleDueTransitions(tx, gameId, nowIso)`, which runs `select bbb_settle_card_effects($1, true, $2)` with the mutation's own `now` (pipeline step 3: after authorize and `clock_timestamp()`, before `loadBehaviorState`) and returns the appended count and last transition seq
    - Every Card_Behavior_Mutation route (play, keep, discard, forfeit, claim, unclaim, bonus, challenge resolve, Fairest decision, host challenge and host effect overrides) calls it inside the mutation's transaction, under the game lock it already holds; the settle is a no-op for a game that is not live
    - Response `seq` is the last **mutation** event (types other than `effect_activated` / `effect_expired`); exactly-one counts and "write nothing" exclude transition events; a rejection returns after the settle, committing only transition events and their announced flags; a thrown error rolls back domain rows, mutation events, and transition events together (`unavailable`)
    - _Requirements: 19.5, 19.9, 19.10, 20.3b, 20.3c, 20.4_

  - [x] 6.8 Write unit tests for the lazy settle helper
    - Fake `QueryRunner`: passes the mutation's `now`, runs before `loadBehaviorState`, reports the last transition seq, and propagates thrown errors so the caller rolls back
    - _Requirements: 19.9, 19.10_

- [x] 7. Player-facing routes
  - [x] 7.1 Rework `app/api/games/[gameId]/cards/play/route.ts`
    - Body adds `params`; pipeline: lock, `clock_timestamp()`, lazy settle (6.7), `loadBehaviorState`, `planCardPlay`; write `card_plays` (slug, targets, params), deck transition, challenges, offers, effects, claim revocations, released protections, reconciled ledger entries; append `card_played` with embedded records plus one `claim_removed` for Voted Off
    - Map `invalid_card` / `target_ineligible` → `invalid_input`, `not_live` → `conflict`, card not in hand → `conflict`; Pioneer/Scenic with no Legal_Next_Bar → `invalid_input` with `details.reason = "no_legal_next_bar"` and `rules`
    - _Requirements: 4.1, 4.3, 6.4, 6.5, 9.11, 10.10, 18.4, 19.2, 19.7, 19.8, 19.9, 22.2, 22.3, 22.5_

  - [x] 7.2 Write route tests for card play
    - Extend `cards/play/route.test.ts`: atomic success per resolver family with expected rows and events, write-free rejection per error, Fairest via play rejected, Pioneer/Scenic `no_legal_next_bar` rejection with the card still in hand, Pioneer/Scenic play with an illegal mirror succeeds with no offer, injected append failure → `unavailable` with no rows
    - Lazy settle: with a due-transition fixture, the settle call precedes `loadBehaviorState`, transition events precede `card_played`, and a rejection commits no domain rows and no mutation events (transition events allowed)
    - _Requirements: 9.15, 10.10, 19.5, 19.7, 19.9, 19.10, 24.2_

  - [x] 7.3 Add inventory follow-ups to discard, keep, and forfeit
    - In `cards/_shared.ts` and the `discard`, `keep`, `forfeit` routes: run the lazy settle (6.7) before loading state, then `settleInventoryChange` after the transition and embed UIOLI completion and voided offers in the single inventory event; `discard` accepts `reason: "cannot_play"` and rejects it with `conflict` via `checkCannotPlayDiscard` while a Fairest decision is pending; keep honors `keep_all`
    - _Requirements: 5.5, 8.3, 8.4, 8.5, 9.12, 17.2, 19.9, 19.10_

  - [x] 7.4 Write route tests for discard, keep, and forfeit
    - Extend `discard/route.test.ts` and `keep/route.test.ts`, add `forfeit/route.test.ts`: UIOLI completes in the emptying transaction, exactly one mutation event for discard (with a due-transition fixture so the lazy settle appends a transition event first), `cannot_play` discard rejected with `conflict` and no domain rows or mutation events while a Fairest offer is pending, Fairest leaving hand voids offers, append failure rolls back transition and mutation events
    - _Requirements: 5.5, 8.3, 8.5, 19.5, 19.9, 19.10, 24.2_

  - [x] 7.5 Rework claim and unclaim in `app/api/games/[gameId]/claims/route.ts`
    - Lazy settle (6.7) after the lock and `clock_timestamp()`, before loading state
    - Use `resolveGameBar`; after attestation run `evaluateClaimBlocks(mode: "claim")` against server `now` → `blocked` with `details.blocks`
    - On success: claim insert, `planClaimSideEffects`, reconciliation with phantom and floors, award ledger entries, effect updates, finish-bar end with `endGameEffects`, draw with `drawOverride`; keep existing event types and embed changed effects and awards in `claim_recorded`
    - Unclaim: `planUnclaimSideEffects`, reconciliation, reversal entries; embed records in `claim_removed`; Voted Off re-claims draw no cards
    - _Requirements: 4.2, 4.3, 7.3, 10.6, 11.3, 12.4, 13.3, 13.9, 14.5, 15.2, 15.5, 16.2, 16.3, 16.4, 17.2, 18.6, 19.1, 19.2, 19.3, 19.4, 19.9, 20.3c_

  - [x] 7.6 Add the `action: "bonus"` Bonus_Claim to the claims route
    - Lazy settle (6.7) first; use `planBonusClaim`; write +5 and the award; append exactly one `happy_hour_bonus_claimed` mutation event with `scoreEntries`; no claim, no draw
    - _Requirements: 13.5, 13.6, 13.7, 19.6, 19.9, 19.10_

  - [x] 7.7 Write route tests for claims
    - Extend `claims/route.test.ts`: blocked details list every block with end times, a timed block enforced at server time with no transition event yet, side-effect writes in one transaction, unclaim reversals, Bonus_Claim exactly-one-mutation-event (with a due-transition fixture) and each rejection, rejections commit no domain rows or mutation events, settle precedes `loadBehaviorState`, append failure rollback
    - _Requirements: 19.3, 19.4, 19.5, 19.6, 19.9, 19.10, 20.3c, 24.2_

  - [x] 7.8 Create `app/api/games/[gameId]/challenges/[challengeId]/resolve/route.ts`
    - Body `{ outcome: "completed" | "failed" }`; `assertMember`, `clock_timestamp()`, lazy settle (6.7), actor team from session, `resolveChallenge`; one `challenge_resolved` mutation event embedding the challenge and any critic block effect
    - _Requirements: 4.4, 4.6, 5.2, 5.3, 5.4, 5.5, 7.2, 7.4, 19.6, 19.9, 19.10_

  - [x] 7.9 Write route tests for challenge resolution
    - Target-team-only authorization, `already_resolved`, `conflict` with a live offer, exactly one mutation event with a due-transition fixture, rejections commit no domain rows or mutation events, append failure rollback
    - _Requirements: 5.3, 5.4, 5.5, 19.5, 19.6, 19.9, 19.10, 24.2_

  - [x] 7.10 Create `app/api/games/[gameId]/fairest-offers/[offerId]/route.ts`
    - Body `{ decision: "play" | "decline" }`; holder-only (`not_authorized`); `clock_timestamp()`, lazy settle (6.7), `decideFairest`; one `fairest_decided` mutation event embedding `cards`, the mirrored challenge or effect, and every changed offer
    - Pioneer/Scenic Play re-checks `mirrorIsLegal` at the decision's `now`; failure → `invalid_input` with `details.reason = "no_legal_next_bar"` and `rules`, no mutation writes, offer stays `pending`
    - _Requirements: 9.4, 9.5, 9.8, 9.9, 9.13, 9.16, 9.17, 19.6, 19.9, 19.10_

  - [x] 7.11 Write route tests for Fairest decisions
    - Holder-only authorization, decline and play outcomes, Fairest no longer in hand → `conflict`, decided offer → `already_resolved`, Pioneer/Scenic Play whose mirror became illegal → `invalid_input` with the offer still pending and Decline still accepted afterwards, exactly one mutation event with a due-transition fixture, rollback
    - _Requirements: 9.4, 9.5, 9.16, 9.17, 19.5, 19.9, 19.10, 24.2_

  - [x] 7.12 Write integration test for claim and play races
    - `supabase/__tests__/integration/cardBehaviorRace.integration.test.ts`: concurrent claim and Crop Dusting / challenge play serialize under the game lock
    - _Requirements: 19.2, 24.4_

- [ ] 8. Checkpoint - persistence and routes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Projection and toasts
  - [x] 9.1 Add `CardBehaviorView` to the board fold in `lib/gameboard/events.ts`
    - `GameBoardView.cardBehavior` (plays, challenges, offers, effects, awards, seq-ordered deduped `toastEvents`); `applyRecordSections` upserts embedded records by id, folds `scoreEntries` via `applyScoreEntry`, applies `removedClaims`
    - Handle `card_played`, `challenge_resolved`, `fairest_decided` (also through `applyCardInventoryEvent`), `happy_hour_bonus_claimed`, `host_override_applied`, `effect_activated` / `effect_expired` (set `startAnnounced` / `endAnnounced` from the embedded record and push **no** toast events; Boundary_Toasts come from 9.7), `score_awarded` payout toast events, and `game_ended` (cancel uncancelled effects with `game_ended`, drop pending actions)
    - Keep `activeEffects`, `activeRestrictions`, `activeChallenges`, `notifications` as deprecated read-only aliases; keep the seq watermark and foreign-game `RangeError`
    - _Requirements: 3.9, 20.6, 23.1, 23.2, 23.3, 23.4, 23.5_

  - [x] 9.2 Create selectors in `lib/gameboard/cardBehavior.ts`
    - `selectOpenChallengesFor`, `selectEffectPhases`, `selectClaimBlocksForBar` (wraps `evaluateClaimBlocks`), `selectMapOverlays`, `selectBonusClaimable`, `selectHostItems` (every challenge and pending/active effect with its valid actions, including each unconsumed Pioneer or Scenic Route restriction labeled with its team and an End effect action)
    - Board timers use `nextBoundaryAfter` from `lib/cards/effects.ts` (2.5); no separate boundary selector
    - _Requirements: 4.5, 10.9, 11.6, 12.8, 13.4, 20.7, 21.10, 21.11_

  - [x] 9.3 Write property test for the projection fold
    - **Property 23: Projection fold is idempotent, isolated, and snapshot-equivalent**
    - File `lib/gameboard/events.cardBehavior.property.test.ts`; arbitrary sequences of the new record-bearing events with duplicates and snapshot splits
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5**

  - [x] 9.4 Create `lib/cards/toasts.ts`
    - `ToastKind`, `ToastAction`, `Toast`, `audienceRole`, `deriveToasts` (routing rules per the design: team plays, bar/self/no-target plays with overrides, payout, mirror and mirror_others, host override, Voted Off target body; effect transition events produce no toast), `selectPendingActions`, `CLAIM_BLOCKED_HEADLINE`
    - Pending action toasts derived from current challenge/offer state; the Fairest prompt hides Mark complete / We failed / UIOLI "Can't play, discard"; Pioneer, Scenic, and UIOLI target toasts have no Mark complete; action toasts not dismissable
    - Per-game localStorage dismissal record `{ floorSeq, dismissed }`, shared with Boundary_Toasts (9.7)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 5.1, 7.1, 9.1, 9.3, 9.6, 9.7, 9.12, 10.8, 11.4, 12.5, 16.6, 18.8, 21.8_

  - [x] 9.5 Write property test for audience routing
    - **Property 4: Audience routing partitions every toast-producing event**
    - File `lib/cards/toasts.property.test.ts`; assert effect transition events produce no toast
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 9.6, 9.7, 11.4, 12.5, 16.6, 18.8, 21.8**

  - [x] 9.6 Write property test for pending actions
    - **Property 5: Pending actions are a pure function of challenge and offer state**
    - File `lib/cards/toasts.pending.property.test.ts`
    - **Validates: Requirements 3.8, 3.9, 5.1, 7.1, 9.2, 9.3, 9.12, 10.8**

  - [x] 9.7 Create `lib/cards/boundaryToasts.ts`
    - Pure `BoundaryToastInput`, `boundaryToastId(effectId, kind)` (`boundary:${effectId}:${start|end}`), and `deriveBoundaryToasts(input)` over `toastBoundaries(effects)` (2.5): Cancel Culture start; Crop Dusting, Cancel Culture, Happy Hour, and Power Hour end, to all teams, using the catalog start/end copy
    - Include boundary `b` when `b.atMs <= serverNowMs` (local timer) or its id is in `announced` (built from the projection's `startAnnounced` / `endAnnounced` flags as the event fallback); both sources yield one id, so dedupe holds
    - Missed-boundary catch-up after reload or reconnect: show boundaries that passed while away, unless the id is in `dismissal.dismissed` or the source play's seq is at or below `dismissal.floorSeq`
    - Suppression after game end: when `lifecycle === "ended"`, include only ids already in `sessionShown`; host- and game-end-cancelled effects have no end boundary
    - Order by `atMs`, then id
    - _Requirements: 3.7, 11.5, 12.6, 12.7, 13.10, 17.4, 20.3a, 20.6, 20.10, 20.11, 20.12_

  - [x] 9.8 Write property test for Boundary_Toast display
    - **Property 25: Boundary_Toasts are shown at most once per board**
    - File `lib/cards/boundaryToasts.property.test.ts`
    - Model interleavings of local timer fires, transition-event folds, reloads (fresh `sessionShown`, persisted dismissal record), dismissals, and game end; assert each boundary id is shown at most once per board, missed boundaries reappear after reload unless dismissed or at/below `floorSeq`, nothing new appears after game end, and host/game-end cancellations never yield an end toast
    - Required by 24.7 (Boundary_Toast at-most-once display)
    - **Validates: Requirements 20.6, 20.10, 20.11, 20.12**
    - _Requirements: 24.7_

  - [x] 9.9 Create `lib/realtime/recheck.ts` and `fetchEventsAfter`
    - `RECHECK_INTERVAL_MS = 15_000`, `RecheckDeps`, `RecheckController` (`noteEvent`, `start`, `stop`), and pure `nextRecheckAt(state): number | "now" | null`
    - Quiet deadline: the later of `lastAppliedCreatedAtMs + 15 s` (server time via the Server_Clock_Offset) and `lastFireMs + 15 s`; `noteEvent` advances it only on contiguous watermark progress; a seq gap fetches immediately; armed only while live; a failed fetch re-arms without applying
    - On fire, `fetchEventsAfter(gameId, lastSeq())` and apply through the existing seq-ordered, deduplicating fold, then re-arm; use the `Scheduler` from `reconnect.ts`
    - Add `fetchEventsAfter` to `SnapshotSource` and implement it in `supabaseBrowser.ts` (`.gt("seq", afterSeq).order("seq")`, RLS-scoped); keep the existing `ReconnectController` / `ResumeController` snapshot-plus-tail refetch on reconnect
    - _Requirements: 23.6, 23.7, 23.8_

  - [x] 9.10 Write unit tests for the recheck controller
    - `lib/realtime/recheck.test.ts` with a fake scheduler: fires after 15 s quiet, restarts on contiguous events, fetches at once on a seq gap, does not run when not live, re-arms after a failed fetch; reconnect still refetches snapshot plus tail
    - _Requirements: 23.6, 23.7, 23.8_

- [x] 10. Board UI
  - [x] 10.1 Update `components/board/CardsRegion.tsx`
    - "Can't play, discard" on each held card while the team has an open UIOLI challenge (posts `/cards/discard` with `reason: "cannot_play"`), hidden while a Fairest prompt is pending for that challenge; Fairest shows no Play button and the note "Played from a challenge prompt"
    - _Requirements: 8.2, 9.3, 9.11_

  - [x] 10.2 Update `components/board/CardPlayPanel.tsx`
    - Input step before targeting: seven `aria-pressed` color toggles (exactly three), minutes/seconds inputs for 0:00-5:00 shown as `m:ss`, cuisine input with `maxLength=60`; Requires text above confirm; graying with reason labels from the extended selectors; send `params` in the play POST; Voted Off keeps bar-then-team
    - Pioneer/Scenic picker: teams with reason `no_legal_next_bar` are grayed with "No legal next bar for this team" plus the rules involved (for example "already under Pioneer"), keyboard-focusable with `aria-disabled`; a server `invalid_input` with that reason shows inline
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 10.12, 12.2, 18.3, 22.1, 22.5_

  - [x] 10.3 Create `components/board/ToastStack.tsx`
    - Inline non-modal stack rendering `deriveToasts`; `role="status"` sections, action toasts `role="alert"` focusing the first action; others' dropdown via `<details>/<summary>`; 44×44 px buttons that wrap at 320px; buttons disable while posting and show server errors inline; Fairest prompt Play/Decline posts `/fairest-offers/{id}`, Mark complete / We failed post `/challenges/{id}/resolve`
    - Pioneer/Scenic Fairest prompt re-evaluates `mirrorIsLegal` from the current view on every render; while false it shows "Mirroring is no longer legal: {Caster} would have no legal next bar." with Play disabled and Decline enabled; a server `invalid_input` on Play shows inline and the prompt stays open
    - Merge Boundary_Toasts from `deriveBoundaryToasts` (9.7) into the same stack, keyed by toast id in a `Map` so re-deriving never duplicates a visible toast
    - Keep `TargetedNotification` only for historical `wireframe_card_played`
    - _Requirements: 3.1, 3.3, 3.7, 3.8, 5.1, 7.1, 9.1, 9.2, 9.3, 9.4, 9.17, 9.18, 20.12, 24.5_

  - [x] 10.4 Update `components/board/MapRegion.tsx`
    - On `blocked` or a `selectClaimBlocksForBar` pre-check, show `CLAIM_BLOCKED_HEADLINE` and the blocking cards with end Clock_Times; "Claim bonus" in the bar popup for `selectBonusClaimable` bars posting `action: "bonus"`
    - _Requirements: 3.10, 4.5, 13.4_

  - [x] 10.5 Add overlays to `components/board/BarLeafletMap.tsx`
    - From `selectMapOverlays`: dashed "restricted" outline for the restricted team only, Crop Dusting lock badge for non-casters, Cancel Culture `L.Circle` radius 402.336 m (dashed/translucent pending, solid active), Happy Hour "+5" badge; every overlay has a text label
    - _Requirements: 10.9, 11.6, 12.8_

  - [x] 10.6 Wire the new UI into `app/games/[gameId]/board/page.tsx`
    - Render `ToastStack`, pass overlays, claim-block context, and action handlers to the regions
    - Start a `RecheckController` (9.9) while the game is live, call `noteEvent` for every applied Realtime or recheck event, and stop it on unmount or game end; keep the reconnect snapshot-plus-tail refetch
    - _Requirements: 3.9, 4.5, 13.4, 23.6, 23.7, 23.8_

  - [x] 10.7 Write component tests for ToastStack, CardPlayPanel, and CardsRegion
    - Toast copy per card, Fairest prompt hides actions, Pioneer/Scenic Fairest "no longer legal" notice with Play disabled and Decline enabled, picker "No legal next bar for this team" graying label, input-step validation, Requires display, UIOLI discard action
    - _Requirements: 1.6, 3.1, 6.6, 8.2, 9.3, 9.18, 10.12_

  - [x] 10.8 Extend viewport tests to the new UI
    - Add 320px and desktop band coverage for `ToastStack`, the play input step, and map claim-blocked messaging (`components/board/ToastStack.viewport.test.tsx` and the board `page.viewport.test.tsx`), checking no clipping and keyboard operability
    - _Requirements: 24.5_

  - [x] 10.9 Write the live delivery integration test
    - `supabase/__tests__/integration/recheckDelivery.integration.test.ts` (runs only under `npm run test:integration`): commit an event for a live game and assert the Target_Team member's Board_Projection, driven by Realtime plus the `RecheckController`, includes it within one Recheck_Interval (15 s), retrying the assertion up to 3 times before failing
    - _Requirements: 23.8, 24.4, 24.6_

- [x] 11. Host overrides
  - [x] 11.1 Create `app/api/games/[gameId]/host/challenges/[challengeId]/route.ts`
    - Body `{ action: "clear" | "reset" }`; `assertAdmin` (`not_admin` → `not_authorized`); `clock_timestamp()`, lazy settle (6.7); `hostChallengeOverride`; one `host_override_applied` mutation event
    - _Requirements: 21.1, 21.2, 21.3, 21.7, 21.9, 19.9, 19.10_

  - [x] 11.2 Create `app/api/games/[gameId]/host/effects/[effectId]/route.ts`
    - Add pure `planHostEffectEnd` to `lib/cards/effects.ts`: `cancelled_at = now`, `cancel_reason = 'host'`; Party Crasher reconciles without phantom; attached Insurance releases then reconciles; a Pioneer or Scenic Route `next_claim_restriction` is cancelled so `evaluateClaimBlocks` and `hasLegalNextBar` stop applying it; awards untouched; already ended/consumed/cancelled → `already_resolved`
    - Route: body `{ action: "end" }`; `assertAdmin`, `clock_timestamp()`, lazy settle (6.7), one `host_override_applied` mutation event embedding the effect and score entries
    - _Requirements: 21.4, 21.5, 21.6, 21.7, 21.9, 21.11, 19.9, 19.10_

  - [x] 11.3 Write route tests for host overrides
    - Host-only authorization (`not_authorized`, no writes), clear/reset transitions including critic block cancellation and UIOLI reset `conflict`, effect end for each kind including a Pioneer/Scenic restriction (the team's next claim is no longer restriction-blocked), awards unchanged, exactly one mutation event with a due-transition fixture, append failure rollback
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.9, 21.11, 19.9, 19.10, 24.2_

  - [x] 11.4 Create `components/board/HostCardPanel.tsx` and wire it into the board page
    - Host-only while live: every challenge (status, target, card) with Clear/Reset and every pending/active effect with "End early" from `selectHostItems`, including each unconsumed Pioneer or Scenic Route restriction labeled with its team; confirm before posting
    - _Requirements: 21.8, 21.10, 21.11_

  - [x] 11.5 Write viewport tests for HostCardPanel
    - `components/board/HostCardPanel.viewport.test.tsx` at 320px and desktop bands, keyboard operable
    - _Requirements: 24.5_

- [x] 12. Timer settlement
  - [x] 12.1 Write `supabase/migrations/0014_card_effect_sweep.sql`
    - Implement early (right after 5.1, see the dependency graph), because the lazy settle in 6.7 calls this function
    - One begin/commit. The migration creates no schedule of any kind: no scheduler job, no `cron.schedule` call, and no reference to the `cron` schema
    - `bbb_settle_card_effects(p_game_id uuid default null, p_wait boolean default false, p_now timestamptz default null) returns integer` mirroring `planEffectTransitions`: for each live game with due transitions (all games, or just `p_game_id`), lock the game row (`for update`, or `for update skip locked` when not waiting; re-entrant inside a mutation that already holds the lock), read `coalesce(p_now, clock_timestamp())`, and for each due transition ordered by boundary then id conditionally flip `start_announced_at` / `end_announced_at`, appending one `effect_activated` / `effect_expired` event (actor `system`, payload `{effectId, slug, kind, barKey, ownerTeamId, targetTeamId, startsAt, endsAt, effects:[record]}`) only when a row returned; return the count; no-op for games that are not live
    - Redefine `bbb_run_auto_timeout_sweep()` to cancel ended games' effects with `cancel_reason = 'game_ended'`
    - `grant execute` on `bbb_settle_card_effects` only to the server role the routes use; `revoke execute` from `anon` and `authenticated`
    - _Requirements: 19.9, 20.1, 20.3b, 20.3d, 20.4, 20.5c, 20.6_

  - [x] 12.2 Create `app/api/games/[gameId]/effects/settle/route.ts` (Settle_Nudge)
    - `assertMember` → `missing_session` / `not_member` before any settle call, writing nothing
    - In its own transaction call `select bbb_settle_card_effects($1, true)` (`p_now` null, so only transitions due at the server time read after the lock are appended); respond `{ applied: true, seq, result: { appended, serverNow } }` with `serverNow` = `clock_timestamp()` for the Server_Clock_Offset; failures → `unavailable`
    - _Requirements: 20.3b, 20.4, 20.5b, 20.5c, 20.8, 20.9_

  - [x] 12.3 Create `app/api/cron/card-effects/route.ts` (optional Cron_Route)
    - GET/POST requiring `CRON_SECRET` bearer, failing closed when unset; call `bbb_settle_card_effects(null, false)`; do not add it to `vercel.json` crons
    - _Requirements: 20.3d, 20.4, 20.5a_

  - [x] 12.4 Write route tests for settlement
    - Settle: `missing_session` / `not_member` write nothing and never call the settle function; member call returns `appended`, `seq`, and `serverNow`; cron: missing secret config and wrong bearer refused, valid bearer calls the function; failures → `unavailable`
    - _Requirements: 20.5a, 20.5b, 20.5c, 20.9, 24.2_

  - [x] 12.5 Add the board timers, Server_Clock_Offset, and `EffectsStrip`
    - Server clock offset from settle: after every Settle_Nudge response, set the offset with `measureOffset(sentAt, receivedAt, serverNow)` (1.5); all countdowns and boundary checks use `serverNow(Date.now(), offset)`
    - Nudge timer: call `/effects/settle` on mount, on reconnect, and at each known boundary + 3 s + random 0-2 s jitter (within 5 s); never while the game is not live; no server-side schedule backs it, so a game with no connected board gets no timing guarantee
    - Toast timer: `setTimeout` at `nextBoundaryAfter(effects, serverNow).atMs`, then re-derive Boundary_Toasts with `deriveBoundaryToasts` (9.7), passing `announced` from the folded flags, a per-session `sessionShown` set, and the per-game dismissal record; add shown ids to `sessionShown`
    - Reschedule both timers after each fold, each fire, each offset change, and on `visibilitychange`; on reload, the first derive performs the missed-boundary catch-up, and after game end it suppresses boundaries that passed while away
    - Create `components/board/EffectsStrip.tsx` listing pending/active timed effects with countdowns from server time; wire timers and the strip into `app/games/[gameId]/board/page.tsx`
    - _Requirements: 3.7, 20.3a, 20.3d, 20.7, 20.8, 20.9, 20.10, 20.11, 20.12_

  - [x] 12.6 Write viewport tests for EffectsStrip
    - `components/board/EffectsStrip.viewport.test.tsx` at 320px and desktop bands
    - _Requirements: 20.7, 24.5_

  - [x] 12.7 Write integration tests for settlement
    - `supabase/__tests__/integration/cardEffectSweep.integration.test.ts`: migrations 0013/0014 apply (the no-schedule check lives in the hermetic 12.8 text test); `bbb_settle_card_effects` agrees with `planEffectTransitions` on seeded fixtures; idempotent across concurrent Settle_Nudge, mutation (lazy settle), and Cron_Route calls; the partial unique index rejects a duplicate transition event
    - _Requirements: 19.9, 20.3b, 20.4, 24.4_

  - [x] 12.8 Write a hermetic text test for migration 0014
    - `supabase/__tests__/cardEffectSweep.migration.test.ts`: the migration file contains no `cron.` reference and no `schedule(` call, and revokes execute from `anon` and `authenticated`
    - _Requirements: 20.3d, 20.5c_

- [x] 13. Oracle and steering updates
  - [x] 13.1 Update `docs/card-text-oracle.md`
    - Describe the Fairest prompt as a dedicated toast shown before the holder's normal challenge actions; state Mirrored_Challenges cannot be mirrored again; record that `lib/cards/cardText.ts` is the in-code home of the copy and the `CardText` reshape is complete; re-run the oracle parity test from 1.4
    - Change the oracle's status line from a "first-pass proposition" / "nothing is locked" to a locked status that names `lib/cards/cardText.ts` as the in-code source of truth for card copy (Requirement 2.3, 2.4)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 13.2 Update `.kiro/steering/structure.md`
    - Under `app/` list the new route directories (`api/cron/card-effects`, and under `api/games/[gameId]`: `challenges`, `fairest-offers`, `host`, `effects`); note the new `lib/cards` (including `boundaryToasts.ts`, `clockOffset.ts`), `lib/claims/blocks.ts` and `lib/claims/legalNextBar.ts`, `lib/map` geo/bar-resolver, `lib/realtime/recheck.ts`, and `lib/scoring/allocation.ts` responsibilities in the `lib/` descriptions; keep the Top-Level Layout unchanged (no new top-level directories)
    - _Requirements: 19.8, 20.5a, 20.5b_

- [~] 14. Final checkpoint - full verification
  - Run `npm test`, lint, type-check, and `npm run build`; confirm the default run stays offline and integration suites (including 10.9) run only under `npm run test:integration`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7_

## Notes

- Sub-tasks marked `*` are optional. Tests that Requirement 24 explicitly mandates are left
  unmarked: the 24.1 property tests (Properties 6, 7, 8, 9, 13, 14, 16, 17, 18, 19, 23),
  the 24.7 property tests (Properties 12, 15, 22, 24, and 25), route tests for every new
  mutation (24.2), the oracle parity test (24.3), viewport tests (24.5), and the live
  delivery integration test in 10.9 (24.6).
- The design's Correctness Properties number 1-25. Property 24 (3.18) is the Legal_Next_Bar
  guard and Property 25 (9.8) is Boundary_Toast at-most-once display.
- "Exactly one event" and "write nothing" in route tests count mutation events and domain
  rows only; transition events appended by the lazy settle are excluded (19.10).
- Property tests use fast-check under Vitest with at least 100 runs each, tagged
  `Feature: card-behavior, Property N: <title>`.
- Route tests use a fake `QueryRunner`; anything touching a live database or Realtime goes in
  `supabase/__tests__/integration` so `npm test` stays hermetic.
- Correctness never depends on settlement having run; claims, plays, and resolutions evaluate
  effects lazily against server time read after the game lock.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.3", "2.8", "2.11", "5.1", "6.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.1", "2.4", "2.5", "2.9", "2.10", "2.12", "5.2", "6.2"] },
    { "id": 2, "tasks": ["1.6", "1.7", "2.2", "2.6", "2.7", "3.1", "5.3", "12.1"] },
    { "id": 3, "tasks": ["3.17", "12.8"] },
    { "id": 4, "tasks": ["3.2", "3.5", "3.8", "3.12"] },
    { "id": 5, "tasks": ["3.3", "3.4", "3.6", "3.7", "3.9", "3.10", "3.11", "3.13", "3.18", "6.3", "6.4"] },
    { "id": 6, "tasks": ["3.14", "3.15", "3.16", "6.5", "6.6", "6.7", "9.1"] },
    { "id": 7, "tasks": ["6.8", "7.1", "7.3", "7.8", "7.10", "9.2", "9.3", "9.4", "9.9"] },
    { "id": 8, "tasks": ["7.2", "7.4", "7.5", "7.9", "7.11", "9.5", "9.6", "9.7", "9.10"] },
    { "id": 9, "tasks": ["7.6", "9.8", "10.1", "10.2", "10.3", "10.4", "10.5", "11.1", "11.2"] },
    { "id": 10, "tasks": ["7.7", "7.12", "10.6", "10.7", "11.3", "12.2", "12.3"] },
    { "id": 11, "tasks": ["10.8", "10.9", "11.4", "12.4", "12.7"] },
    { "id": 12, "tasks": ["11.5", "12.5"] },
    { "id": 13, "tasks": ["12.6", "13.1", "13.2"] }
  ]
}
```
