# Card Implementation Tasks

## Purpose

This is the execution plan for turning the existing card wireframe into the complete BBB card system. It follows the architecture and requirements in `plan.md`, `cards.md`, and the existing `in-game-landing-wireframe` spec.

The delivery order is deliberately incremental:

1. Prove the wireframe interaction and realtime notification path.
2. Build shared card infrastructure and replace wireframe state with durable state.
3. Implement the generic play, challenge, effect, notification, claim, timer, and score primitives.
4. Wire the finalized cards one at a time, each with focused domain tests and route/integration coverage.
5. Remove placeholders only after the real path is proven end to end.

### Working rules

- Every successful domain mutation writes its state change and exactly one canonical `game_event` in one transaction.
- Rejected mutations write nothing and return a stable reason.
- Server/database time decides activation and expiry.
- `game_events` is the propagation and audit log, not the current-state store.
- Card-specific behavior belongs in focused validators/resolvers, not scattered through claim or notification routes.
- Photo/video upload and automated evidence validation remain out of scope; manual confirmation is the MVP.
- Each task that changes behavior adds or updates a focused pure, route, database, or integration test before moving to the next dependency.

## Phase 0: Wireframe baseline and delivery gate

The implementation already exists in the repository. Treat it as the executable contract for the later card system, not as a second card implementation.

- [x] 0.1 Confirm the functional wireframe surface
  - Verify the live board exposes Bars, Scoreboard, and Cards regions.
  - Verify a placeholder card can be played, a target can be selected, and a confirmation is shown.
  - Verify the `wireframe-card-play` route appends one `wireframe_card_played` event atomically.
  - Verify the target team receives a folded `TargetedNotification` and can dismiss it.
  - Keep the placeholder behavior non-enforcing: no real hand mutation, claim block, score change, or card effect.
  - Evidence: `app/games/[gameId]/board/page.tsx`, `app/api/games/[gameId]/wireframe-card-play/route.ts`, `components/board/CardPlayWireframe.tsx`, and existing board tests.

- [x] 0.2 Run the wireframe baseline checks
  - Run the focused board, card-play, notification, property, and viewport tests.
  - Run `npm run typecheck` and `npm run lint` for the baseline.
  - With Supabase configured, run the environment-gated realtime delivery and game-isolation checks.
  - Record any pre-existing failures before card implementation begins.
  - Result: local focused suites passed (9 files, 77 tests), `npm run typecheck` passed, and `npm run lint` completed with four pre-existing warnings and no errors. The configured Supabase integration test passed channel isolation but timed out delivering the committed `wireframe_card_played` event within 5 seconds; classify this as an environment/infrastructure blocker to resolve before the realtime release gate.
  - Done when the baseline is green or failures are explicitly classified as unrelated blockers.

- [x] 0.3 Define the real-path cutover contract
  - Document the response shapes and stable error reasons shared by card play, challenge resolution, and claim authorization.
  - Decide which existing wireframe event fields map to real `card_plays` fields and which are discarded.
  - Define the removal condition for the wireframe route and placeholder hand: the real route and board reducer must pass the same end-to-end notification tests first.
  - Contract and cutover gate: see `plan.md`, "Phase 0 cutover contract".

## Phase 1: Shared card domain primitives

- [x] 1.1 Resolve implementation decisions before migrations
  - Seed each team's deck at game start, unless an existing game lifecycle hook requires game creation.
  - Store a server-generated draw order, with a durable seed or position; never derive order from client state.
  - Define when an unresolved challenge blocks claims and preserve the inline-drink exception.
  - Choose the score-ledger representation and the distance calculation used by map restrictions.
  - Record each decision in `plan.md` or a decision record before schema work.
  - Decisions recorded in `plan.md`, "Phase 1 implementation decisions".

- [x] 1.2 Extend and validate card metadata
  - Add typed catalog metadata for slug/category, target mode, casting inputs, resolution mode, completion modality, timer/delay, persistence/consumption, notification audiences, and affected domain families.
  - Distinguish team, bar, self, none, team-plus-bar, and reactive targeting.
  - Validate metadata at the catalog boundary; do not treat arbitrary JSONB as executable rules.
  - Add catalog completeness tests for all 23 cards and invalid-metadata rejection tests.
  - Evidence: `lib/cards/catalog.ts` and `lib/cards/catalog.test.ts`.

- [ ] 1.3 Add deck and inventory schema
  - Add game/team deck state, draw position/order, per-bar draw records, discard reason, and lifecycle timestamps.
  - Add constraints proving card instances and holders belong to the same game.
  - Add indexes for current hand, deck top, and per-team/per-bar draw lookup.
  - Add RLS for team-owned inventory reads and server-only inventory writes.
  - Add migration/schema tests and rollback-safe fixture helpers.

- [x] 1.4 Implement pure deck and hand transitions
  - Seed one copy of every card definition per team.
  - Implement draw, keep, discard, play, exhaustion, duplicate-bar prevention, and maximum hand size of two.
  - Implement the Power Hour override as a generic draw policy, not a special UI branch.
  - Make transitions idempotent and return stable rejection reasons.
  - Add fast-check coverage for uniqueness, exhaustion, draw-two/keep-one, hand limits, Power Hour, and repeated requests.
  - Evidence: `lib/cards/deck.ts`, `lib/cards/deck.test.ts`, and `lib/cards/deck.property.test.ts` (18 focused tests pass).

- [ ] 1.5 Define canonical card event vocabulary and reducers
  - Add stable event types for inventory, card play, challenges, effects, notifications, claims, and scores.
  - Extend the board snapshot fold with hand, active challenges, restrictions, notifications, and score explanations.
  - Preserve ordered application, stale-event ignoring, duplicate tolerance, and per-game isolation.
  - Add reducer properties for replay equivalence and idempotency.

- [ ] 1.6 Checkpoint: infrastructure primitives
  - Migrations apply cleanly to a disposable/test database.
  - Pure inventory and reducer suites pass.
  - RLS tests prove cross-game reads and client writes are rejected.
  - No card-specific route has been introduced yet.

## Phase 2: Real card play, challenges, and notifications

- [ ] 2.1 Implement the canonical card-play transaction
  - Replace the wireframe identifier with a real `card_instance_id`.
  - Require a live game, valid player session, active team membership, and an in-hand instance held by that team.
  - Validate target mode, same-game targets, opposing-team rules, reactive response windows, card inputs, and duplicate-target rules.
  - Create `card_plays`, transition the instance, create generic challenge/effect records, and append exactly one `card_played` event.
  - Add route tests proving atomic success, rejected-play no-write behavior, cross-game target rejection, and event-append rollback.

- [ ] 2.2 Implement generic challenge lifecycle
  - Add challenge records and state transitions: announced, awaiting confirmation, in progress, confirmed, rejected, expired, reset, and resolved.
  - Track caster/target teams, source play, blocking status, deadlines, resolver, server timestamps, and structured manual-result data.
  - Support multiple active challenges and the inline-drink exception without relying on client state.
  - Add pure transition properties and database authorization tests.

- [ ] 2.3 Implement manual confirmation, rejection, and admin reset
  - Add target-team completion and rejection actions.
  - Add admin reset/override actions with explicit moderation authorization.
  - Keep unresolved effects active until the required result and record every resolution/reset in the audit log.
  - Add route tests for target authorization, wrong-team rejection, duplicate resolution, and admin override.

- [ ] 2.4 Implement canonical notification routing
  - Derive target, caster, all-team, and uninvolved-team audiences from one routing module.
  - Persist notification identity, source play, audience scope, display payload, expiry, and dismissal state.
  - Emit delayed activation, restriction-start, confirmation, rejection/reset, mirror, and expiration notifications.
  - Add audience and cross-game isolation tests, then wire the board reducer and UI to real notifications.

- [ ] 2.5 Checkpoint: real play path
  - A real card instance can be played from a hand through the server route.
  - The target receives a canonical notification over the existing realtime channel.
  - Reconnect/snapshot folding reconstructs the hand, challenge, effect, and notification state.
  - The wireframe route remains only as a compatibility probe until the cutover task passes.

## Phase 3: Effects, claim authorization, timers, and scoring

- [ ] 3.1 Add generic effect and restriction records
  - Model source play, owner/target scope, effect type, parameters, activation, expiry, consumption, remaining uses, resolution, supersession, and cancellation.
  - Add typed effect constructors and active-effect queries.
  - Add activation/expiry boundary properties and one-shot consumption properties.

- [ ] 3.2 Integrate effects into the claim transaction
  - Evaluate active challenges and restrictions while holding the same game lock as claim recording.
  - Return stable claim-block reasons and append the corresponding claim-block event when appropriate.
  - Cover team blocks, bar locks, radius locks, next-claim restrictions, finish-bar rules, Happy Hour repeat claims, and team membership.
  - Add concurrency tests for claim versus play, resolution, expiry, and duplicate claim races.

- [ ] 3.3 Implement server-time timers and sweep processing
  - Use lazy checks for immediate correctness and a scheduled sweep for activation/expiry cleanup and notifications.
  - Cover Crop Dusting, Everyone's a Critic, Cancel Culture delay/window, Happy Hour, Power Hour, and generic expiration.
  - Ensure retries are idempotent and timer events are appended once.
  - Add boundary tests at start, just-before-expiry, expiry, and after-expiry.

- [ ] 3.4 Add the score ledger and deterministic recalculation
  - Record immutable base shares, bonuses, protections, phantom reductions, and one-time awards with source references.
  - Recalculate deterministically from claims/effects/ledger entries without rewriting historical awards.
  - Award finish-bar points and game end atomically.
  - Add conservation, late-claimer, score-protection, phantom-share, and recalculation properties.

- [ ] 3.5 Checkpoint: shared enforcement
  - A claim cannot bypass an active card restriction, timer, or challenge.
  - Score changes are auditable and replayable.
  - Timer sweep and lazy evaluation agree at every boundary.
  - Realtime clients reconstruct current card and score state after reconnect.

## Phase 4: Wire cards one by one

Each card task follows the same vertical slice: metadata, input schema, focused validator/resolver, effect/challenge/scoring mutation, notification audience, route/domain tests, reducer/event coverage, and one browser-facing interaction test where the card has user input. Do not batch cards into one untestable resolver.

### 4A. Team-targeted challenge cards

- [ ] 4.1 Go Piss Girl
  - Target-team challenge, confirmation, target/caster/informational notifications, unresolved claim block, manual resolution.

- [ ] 4.2 Wired
  - Same shared challenge path with its espresso requirement and manual confirmation payload.

- [ ] 4.3 Broad Shoulders
  - Manual completion for Tiny Door requirement, confirmation/rejection, and notification coverage.

- [ ] 4.4 Interested Buyer
  - Manual completion with souvenir/brochure or outside-app photo alternative recorded as structured result.

- [ ] 4.5 Spin Cycle
  - Resolve the target team's most recently claimed bar and enforce return/confirmation before the next eligible claim.

- [ ] 4.6 Dirty Bird
  - Manual completion for Atlanta sports merchandise and claim-block lifecycle.

### 4B. Cards with caster input or failure outcomes

- [ ] 4.7 Moneybags
  - Validate price input/casting payload shape and record manual target confirmation; evidence remains outside the app.

- [ ] 4.8 Art School Dropout
  - Validate three distinct ROYGBIV colors, capture caster input, and manually confirm the target's different-location requirement.

- [ ] 4.9 Bird Guide
  - Validate duration from 0 through 300 seconds and require matching target duration on manual resolution.

- [ ] 4.10 Different Tastes
  - Validate caster cuisine input and manually confirm the matching-continent requirement.

- [ ] 4.11 Everyone's a Critic
  - Record attempt success/failure, impose the 15-minute claim block on failure, and track the no-internet-research marker.

### 4C. Claim restrictions and reactive cards

- [ ] 4.12 Crop Dusting
  - Validate an eligible current bar, create a 15-minute bar lock, and notify all non-casting teams.

- [ ] 4.13 Pioneer
  - Enforce the target team's next unclaimed non-finish-bar claim restriction and consume it exactly once.

- [ ] 4.14 Scenic Route
  - Compare finish-distance with the team's previous bar using the selected distance policy and consume the next-claim restriction.

- [ ] 4.15 Cancel Culture
  - Validate public bar target and finish-radius rule, schedule the 15-minute delay, activate the 15-minute radius lock, and notify start/activation/expiry.

- [ ] 4.16 Fairest of Them All
  - Restrict play to the immediate response window, mirror the source challenge, share resolution state, and route both notification audiences.

### 4D. Economy, scoring, and inventory cards

- [ ] 4.17 Insurance
  - Self-target the caster, protect the next-bar share from later reductions, and award auditable protected points.

- [ ] 4.18 Happy Hour
  - Validate non-finish bar target, one-hour window, first-drink uniqueness, immutable +5 award, and bonus-only repeat claim behavior.

- [ ] 4.19 Party Crasher
  - Validate fewer-than-four-team target bar, apply the phantom claimant modifier, and remove it when the fourth team claims.

- [ ] 4.20 Patient Investor
  - Track four subsequent claims and award immutable +6 exactly once.

- [ ] 4.21 Power Hour
  - Create the persistent 20-minute draw override and prove it changes draw resolution without changing normal hand limits afterward.

- [ ] 4.22 Use It or Lose It
  - Force hand resolution, discard cards whose requirements cannot be met, play eligible cards through the canonical path, and block the target until resolution.

- [ ] 4.23 Voted Off the Island
  - Enforce the four-team prerequisite, select a bar claimed by all teams, remove only the target team's claim, notify all audiences, and allow a later re-claim.

- [ ] 4.24 Per-card checkpoint
  - Every card in the catalog has metadata, a reachable canonical play path, a focused test matrix, a stable event payload, and a reducer/reconnect replay case.
  - Run a catalog-to-implementation completeness check so no seeded card is silently left on a placeholder resolver.

## Phase 5: UI wiring and removal of placeholders

- [ ] 5.1 Replace the placeholder hand with durable hand state
  - Read the current team hand from the board snapshot/query state.
  - Implement draw-two/keep-one, discard, full-hand resolution, deck exhaustion, and Power Hour UI states.
  - Preserve optimistic-free server authority: acknowledgement follows the committed event.

- [ ] 5.2 Replace the wireframe play dialog with real card input flows
  - Render target modes and typed inputs from card metadata.
  - Surface stable rejection reasons, pending challenges, timers, manual completion actions, and notification audiences.
  - Keep the UI usable at the existing 320-430px viewport band.

- [ ] 5.3 Add challenge and moderation controls
  - Target-team complete/reject actions, admin reset/override, pending/expired/resolved views, and audit details.
  - Ensure unauthorized controls are absent and unauthorized requests are rejected server-side.

- [ ] 5.4 Add scoring explanations and active restrictions to the board
  - Show why a claim is blocked, the timer state, and score ledger categories without exposing another game's data.
  - Add reconnect and stale-event UI states for card inventory, challenges, effects, notifications, and scores.

- [ ] 5.5 Remove the wireframe path
  - Remove `wireframe_card_played`, the wireframe route, placeholder card generation, and placeholder labels only after real card-play, realtime, reconnect, and authorization tests pass.
  - Retain migration/history compatibility as required by the append-only event log; removal means no new production writes, not deletion of historical events.

## Phase 6: End-to-end hardening and release gate

- [ ] 6.1 Run the full unit/property/route suite
  - Deck invariants, metadata, validators, effects, timers, claim authorization, scoring, reducers, and notification audiences.

- [ ] 6.2 Run database and RLS integration coverage
  - Atomic rollback, concurrent claims/plays, cross-game isolation, hand access, manual resolution authorization, admin overrides, and finish-bar end behavior.

- [ ] 6.3 Run environment-gated realtime checks
  - Target-only notifications, non-target informational notifications, channel isolation, reconnect/resume catch-up, timer activation/expiry delivery, and duplicate-event tolerance.

- [ ] 6.4 Run browser and viewport checks
  - Complete a representative challenge, a bar-targeted restriction, a manual resolution, a score-changing card, a reactive card, and a deck mutation on a 320px viewport and a desktop viewport.

- [ ] 6.5 Publish the implementation status
  - Update `plan.md`, `ROADMAP.md`, and the relevant decision records with completed phases, deferred evidence validation, known limitations, and the next production-safe milestone.

## Dependency graph

```text
Phase 0 wireframe gate
  -> Phase 1 metadata/deck/events
  -> Phase 2 real play/challenges/notifications
  -> Phase 3 effects/claims/timers/scoring
  -> Phase 4A team challenges
  -> Phase 4B input/failure cards
  -> Phase 4C restrictions/reactive cards
  -> Phase 4D economy/scoring/inventory cards
  -> Phase 5 UI cutover/removal
  -> Phase 6 hardening/release
```

Phase 4A and 4B can proceed in parallel after Phase 3. Phase 4C depends on the claim authorization and timer checkpoints. Phase 4D depends on the score ledger and deck primitives. Phase 5 depends on all card families that the UI exposes.

## Definition of done

The card implementation is complete when:

- Every finalized card has a typed metadata entry and a canonical resolver.
- Every successful card mutation is atomic with exactly one canonical event.
- Every rejected mutation is stable, authorized, and write-free.
- Current hands, challenges, effects, notifications, restrictions, and scores survive snapshot/reconnect folding.
- Manual challenge resolution and admin reset are audited and authorization-tested.
- Claim restrictions and score effects are enforced server-side under transaction locks.
- The board uses real card instances and notifications, with no production dependency on the wireframe route or placeholder hand.
- The full property, route/database, realtime, and representative browser suites pass.
