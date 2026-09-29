# Card Implementation Plan

This plan describes the backend infrastructure required to make every finalized BBB card implementable. It follows the project's existing process rather than a canonical spec format.

The authoritative card source is `v1/Card List.md`, mirrored in `.kiro/steering/cards.md`. The implementation must preserve the existing BBB architecture:

- Next.js App Router and TypeScript.
- Supabase Postgres as the source of durable game state.
- `postgres.js` for server-side transactional mutations.
- Supabase Realtime over the append-only `game_events` table.
- Per-game session identity and RLS isolation.
- Pure, framework-free domain logic with Vitest and fast-check coverage.

## Goals

The card system must support:

- A separate identical deck for every team.
- Drawing, keeping, playing, and discarding cards.
- Team-targeted, bar-targeted, self-targeted, reactive, and no-target cards.
- Immediate realtime notifications with different audiences.
- Target-team confirmation and challenge resolution.
- Timers, delayed activation, claim restrictions, and one-shot effects.
- Manual challenge completion and rejection controls.
- Score-changing effects without losing an auditable history.
- Card interactions without introducing one-off rules into the claim route.
- Atomic domain changes plus exactly one corresponding game event.

## Current Foundation

Already present in the repository:

- `card_definitions`, `card_instances`, and `card_plays` tables.
- A seeded 23-card catalog.
- Per-game RLS policies.
- Atomic server transactions through `postgres.js`.
- Append-only, ordered, immutable `game_events`.
- Supabase Realtime subscriptions with snapshot folding, deduplication, buffering, reconnect, and resume.
- Map/bar coordinate data suitable for distance-based restrictions.
- A wireframe targeting route that emits `wireframe_card_played`.
- A documented temporary-photo policy, which is intentionally out of scope for card implementation.

The wireframe route is not the real card implementation. It does not consume a card instance, apply an effect, block claims, resolve challenges, or change scores.

## Phase 0 Baseline

The local wireframe baseline is green as of 2026-09-29:

- The focused board, card-play, notification, property, and viewport suites passed: 9 files and 77 tests.
- `npm run typecheck` passed.
- `npm run lint` completed with no errors and four existing warnings: two unused test imports/fixtures and two `next/no-img-element` warnings in unrelated app components.
- The configured Supabase integration check passed channel isolation, but the target subscriber did not receive the committed `wireframe_card_played` event within the five-second delivery window. This is an environment/infrastructure blocker, not a local reducer or route-test failure, and must be resolved before the realtime release gate.

## Phase 0 Cutover Contract

The real card path will use one response envelope for card play, challenge resolution, and claim authorization:

```ts
type MutationResponse<Result = unknown> =
	| { applied: true; seq: number; result?: Result }
	| { applied: false; error: StableMutationError; details?: Record<string, unknown> };
```

`seq` is the committed per-game `game_events` sequence. A successful mutation returns one sequence number for its canonical event. A rejected mutation returns no sequence and writes no domain row or event. `details` is diagnostic/structured context only; clients branch on `error`, never on free-form text.

The shared stable error vocabulary is:

| Error | HTTP status | Meaning |
| --- | ---: | --- |
| `missing_session` | 401 | No usable session identity was supplied. |
| `not_member` | 403 | The session is not an active member of this game. |
| `not_authorized` | 403 | The member exists but cannot perform this action. |
| `invalid_input` | 400 | The request shape or card/challenge input is invalid. |
| `not_found` | 404 | A referenced card, team, bar, challenge, or game object is not in this game. |
| `conflict` | 409 | The request conflicts with current durable state, including duplicate play or claim. |
| `blocked` | 409 | An active challenge, restriction, or timer prevents the action. |
| `expired` | 409 | The relevant response window or effect has expired. |
| `already_resolved` | 409 | A challenge or one-shot action has already been resolved. |
| `unavailable` | 503 | The server could not complete the transaction; no partial mutation is acknowledged. |

The current wireframe route remains compatible with the envelope's `applied`/`seq` success and `applied`/`error` rejection shape. Its legacy `not_found` and `not_member` reasons remain valid during compatibility, while real routes use the shared vocabulary above. The current append-failure 500 response will be normalized to `unavailable` when the real route replaces it.

### Wireframe-to-real field mapping

| Wireframe value | Real path | Decision |
| --- | --- | --- |
| `cardId` payload string | `card_instances.id` | Discard the opaque placeholder value. The real route accepts and authorizes a concrete in-hand instance id. |
| Server-derived `castingTeamId` | `card_plays.casting_team_id` | Preserve the server-derived team; never trust a client-supplied caster. |
| `targetTeamId` payload string | `card_plays.target_team_id` | Preserve only after same-game, target-mode, and opposing-team validation; null for self/no-target cards. |
| Event `seq` | `game_events.seq` and response `seq` | Preserve as the ordered propagation/audit identity; it is not current card state. |
| `cardId` in `wireframe_card_played` payload | No real state field | Retain only for historical event compatibility; no new production writes after cutover. |
| Placeholder label/targeting flag | Catalog metadata | Replace with the typed `card_definitions` catalog entry and resolver metadata. |
| Client timestamp, if any | `card_plays.played_at` | Discard client time; use the database default/server timestamp. |

### Removal gate

Remove new production writes to `wireframe_card_played`, the wireframe route, and placeholder hand generation only after all of the following pass:

1. The real card-play route has atomic success, write-free rejection, same-game target authorization, and event-append rollback coverage.
2. The real board reducer reconstructs hand, challenge, effect, restriction, notification, and score state from a snapshot and reconnect tail.
3. The target-only notification and game-isolation checks pass over the real route and realtime channel, including the currently failing five-second delivery check.
4. Manual challenge resolution, claim authorization, and admin override are authorization-tested.
5. Browser-facing representative card flows pass at the existing 320px and desktop viewport bands.

Historical `wireframe_card_played` rows remain readable by compatibility reducers as needed; removal means no new production writes, not deletion from the append-only event log.

## Phase 1 Implementation Decisions

These decisions close the open questions that control the card schema and are the contract for the next migrations:

1. **Deck seeding:** seed one identical card instance per finalized card definition for every team when the game transitions from `lobby` to `live`. The existing start transaction is the lifecycle hook, so a game cannot become live with an unseeded deck. Seeding is idempotent under a unique `(game_id, team_id, definition_id)` constraint.
2. **Draw order:** generate the order server-side during deck seeding and persist it as a stable position on each card instance. The client never supplies or derives order. A draw claims the lowest available position for that team under the game transaction lock.
3. **Challenge blocking:** an unresolved challenge blocks the target team's next eligible bar claim immediately after the challenge is issued. The inline-drink exception is represented as an explicit challenge/effect parameter and is evaluated by the claim transaction; it is never inferred from client state. Challenge resolution, rejection, expiry, and admin reset are the only ways to clear the block.
4. **Score representation:** use an immutable score ledger. Claims and card effects append typed ledger entries with source references; current scores are deterministic sums over active/relevant entries. Historical awards are never rewritten when later claimants change a bar's normal share.
5. **Distance policy:** use straight-line geodesic distance between stored bar coordinates, measured in miles, for radius restrictions and finish-distance comparisons. This is deterministic, available offline, and appropriate for eligibility rules; walking-route distance is explicitly out of scope for the MVP.
6. **Timer evaluation:** use lazy server-time evaluation for mutation correctness and a scheduled sweep for activation/expiry notifications and cleanup. Both paths read database timestamps and are idempotent.

The typed catalog boundary introduced in `lib/cards/catalog.ts` is the executable metadata contract for these decisions. The SQL catalog remains storage for stable definition identity and descriptive seed data; card rules are selected from validated typed metadata, never executed from arbitrary JSONB.

Phase 1 progress: the typed catalog, inventory migration, pure deck/hand transition model, and canonical board event/reducer slice are implemented and tested. The disposable migration smoke now strips only each file's standalone outer `BEGIN`/`COMMIT` when applying inside its existing test transaction, avoiding postgres.js nested-transaction rejection. Live migration application, cross-game isolation, and card inventory client-write rejection all pass. No card-specific route has been introduced yet.

## Design Principles

### One authoritative mutation path

Every card mutation goes through a server route or server-side domain operation. The browser never directly mutates card state, effects, claims, or scores.

### Atomic state plus event

A successful mutation must write its domain changes and append its canonical `game_event` in the same transaction. If the event append fails, the domain changes roll back too.

### Generic effects, card-specific validation

Cards should share generic effect and restriction records, while each card has a focused validator/resolver. Challenge completion is manual for now: the backend records confirmation or rejection rather than validating photos, videos, or other evidence. Avoid putting card-specific conditionals throughout claims, scoring, and notification code.

### Events are history, not current state

Current card hands, active restrictions, challenge confirmations, and scores should be queryable from durable tables. `game_events` remains the ordered propagation and audit log.

### Server time is authoritative

Timer start, delayed activation, and expiry must use database/server timestamps. Client clocks may display countdowns but cannot decide whether an effect is active.

### Honor-system MVP

Challenges resolve through manual target-team confirmation or rejection. Photo/video evidence, cloud uploads, automated validation, and evidence-feed processing are explicitly out of scope. The data model should record the challenge, manual resolution, actor, timestamp, and audit event so stronger validation could be added in a future phase without blocking current implementation.

## Backend Workstreams

### 1. Card definition metadata

Extend the static card catalog metadata so the application can drive play validation and resolution without interpreting prose.

Required concepts:

- Target mode: `team`, `bar`, `self`, `none`, or `team_and_bar`.
- Card category and slug.
- Casting requirement type.
- Resolution requirement type.
- Required input schema.
- Completion modality: manual confirmation, manual rejection, or none.
- Timer or delayed activation configuration.
- Whether the effect is persistent, one-shot, reactive, or consumable.
- Notification audience rules.
- Whether the card changes scoring, card draw, claims, or challenge state.

Candidate structured fields may include JSONB for extensible requirement and input definitions, but the application must validate the shape rather than treating arbitrary JSON as trusted rules.

The catalog must distinguish at least:

- Team-targeted challenges.
- Bar-targeted restrictions.
- Self-targeted effects.
- No-target persistent effects.
- Reactive cards that are playable only in response to another card.
- Cards requiring caster input before play.

### 2. Deck, draw, and hand management

Implement the game-specific deck lifecycle.

Required behavior:

- Seed one copy of every card definition into each team's deck when appropriate for game start.
- Track draw order without relying on client state.
- Draw the top two cards when a team claims an eligible non-finish bar.
- Let the team keep one and discard the other.
- Enforce a maximum hand size of two.
- If the team already has two cards, require a play or discard before adding another.
- If only one card remains in the deck, allow it to enter the hand.
- If the deck is empty, allow claims without a draw.
- Exclude finish-bar claims from normal drawing.
- Prevent drawing more than once per team per unique bar.
- Allow Power Hour to override the normal keep-one rule for twenty minutes.
- Make every inventory transition atomic and idempotent.

Likely supporting state:

- Team deck or draw-pile state.
- Draw position or shuffled ordering.
- Per-team/per-bar draw record.
- Hand ownership.
- Discard reason.
- Card lifecycle timestamps.

### 3. Real card-play transaction

Replace the wireframe card-play route with a canonical card-play mutation.

The transaction must:

1. Require a valid game session.
2. Verify the game is live.
3. Verify the caster is an active player on a team.
4. Verify the selected card instance is held by that team and is in hand.
5. Validate the card's target mode and target belongs to the same game.
6. Reject self-targeting where the card requires an opposing team.
7. Validate card-specific casting requirements and input parameters.
8. Enforce duplicate-target rules for challenge cards.
9. Create the card play record.
10. Move the card instance to `played` or `discarded` as appropriate.
11. Create any resulting effect, restriction, or challenge records.
12. Append one canonical card-play event.
13. Return the event sequence number and structured result.

Rejected plays must return a stable reason and write nothing.

### 4. Generic effect and restriction model

Create durable records for temporary and persistent consequences of card plays.

The model needs to represent:

- Source card play.
- Owning game.
- Owning team, target team, target bar, or affected region.
- Effect type.
- Creation time.
- Activation time.
- Expiry time.
- Consumption status.
- Remaining uses or claim count.
- Resolution status.
- Supersession or cancellation.
- Relevant structured parameters.

Effect families include:

- Team claim block.
- Bar claim block.
- Geographic/radius claim block.
- Next-claim restriction.
- Score protection.
- Score bonus.
- Phantom claimant scoring modifier.
- Card-draw override.
- Pending challenge.
- Reactive challenge mirror.
- Internet-research restriction marker.
- Manual confirmation requirement.

### 5. Challenge and confirmation workflow

Create a challenge lifecycle separate from the raw card play.

Suggested states:

- `announced`.
- `awaiting_confirmation`.
- `in_progress`.
- `confirmed`.
- `rejected`.
- `expired`.
- `reset_by_admin`.
- `resolved`.

The workflow must support:

- Target-team confirmation.
- Challenge completion before the next eligible claim.
- Multiple active challenges resolved in any order.
- The in-line drink exception from the game rules.
- Manual completion and rejection buttons.
- Admin challenge/reset behavior without media review.
- Fairest of Them All mirroring the original challenge.
- Notifications to the target, caster, and uninvolved teams.

### 6. Manual challenge completion

Photo/video evidence is explicitly out of scope for this phase. Players may use a separate
group chat or the honor system outside the application. The BBB backend only records the
manual result needed to control the game.

Required capabilities:

- Provide a target-team "completed" action.
- Provide a target-team "not completed" or rejection action where the card needs it.
- Allow an admin to reset or override a manual resolution.
- Record the resolving session/team and server timestamp.
- Keep the challenge blocking or score effect active until the required manual result.
- Append a realtime event for each resolution or reset.
- Preserve an audit trail without storing media or evidence objects.

Cards that have real-world requirements but use manual completion include:

- Moneybags: price-tag requirement.
- Art School Dropout: three ROYGBIV colors and a different location.
- Bird Guide: caster duration up to 300 seconds and target duration matching it.
- Different Tastes: caster cuisine input and matching-continent requirement.
- Everyone's a Critic: attempt success/failure and resulting claim block.
- Broad Shoulders and Dirty Bird: real-world completion confirmation.
- Interested Buyer: document/photo alternative confirmed manually.

### 7. Notification and audience routing

Define canonical notification events rather than having each UI component infer recipients.

Notifications must support:

- Target-team toast.
- Caster-team acknowledgement.
- All-team announcement.
- Informational notification to non-target and non-casting teams.
- Delayed activation notice.
- Restriction-start notice.
- Challenge confirmation.
- Challenge rejection or reset.
- Mirrored challenge notice.
- Effect expiration.

Each notification should include a stable event or notification ID, game ID, source card play, audience/team scope, creation time, expiry/dismissal state, and structured display data.

### 8. Claim authorization integration

The real claim transaction must evaluate card effects before recording a claim.

Checks include:

- Unresolved targeted challenges.
- Crop Dusting bar lock.
- Everyone's a Critic penalty.
- Pioneer next-claim restriction.
- Scenic Route distance restriction.
- Cancel Culture radius and activation window.
- Finish-bar restrictions.
- Voted Off the Island claim state.
- Happy Hour bonus-only repeat claim.
- Team membership and half-team drink eligibility.

The claim decision and all resulting state changes must occur under the same game-row lock/transaction discipline as existing mutation routes.

### 9. Scoring ledger and recalculation

Card effects make a simple current-score column unsafe. Add an auditable score ledger or equivalent event-derived score model.

Required properties:

- Every score award or adjustment has a source.
- Awards are immutable once committed.
- Recalculation is deterministic from claims, card effects, and score entries.
- A late claimant can change normal bar shares without rewriting historical bonus awards.
- Finish-bar points are awarded atomically with game end.
- The scoreboard can distinguish base share, bonus, protected share, phantom-share reduction, and one-time investment bonus.

Card-specific scoring support:

- Insurance: protect the caster's next-bar share from later reductions.
- Happy Hour: immutable +5 first-drink bonus and bonus-only repeat claim.
- Party Crasher: phantom claimant while fewer than four teams have claimed.
- Patient Investor: immutable +6 after four subsequent claims.
- Finish-bar award: immutable solo 12 and immediate game end.

### 10. Timers and scheduled processing

Implement a shared server-time timer model.

Required timer cases:

- Crop Dusting: 15-minute bar lock.
- Everyone's a Critic: 15-minute claim block after failure.
- Cancel Culture: 15-minute delay, then 15-minute radius lock.
- Happy Hour: one-hour bonus window.
- Power Hour: twenty-minute draw override.
- Effect expiration and notification.

Use lazy server-side checks for immediate correctness and a scheduled sweep for cleanup and reliable activation notifications. Timer transitions should append events when they become visible to clients.

### 11. Realtime event vocabulary and reducers

Replace the wireframe event with stable event types for:

- Deck seeded.
- Cards drawn.
- Card kept.
- Card discarded.
- Card played.
- Challenge issued.
- Challenge confirmed.
- Challenge rejected.
- Effect created.
- Effect activated.
- Effect expired.
- Claim blocked.
- Claim recorded.
- Claim removed.
- Score awarded.
- Score modifier applied.
- Notification created.

Update the board reducer and snapshot fold so reconnecting clients can reconstruct:

- The current hand.
- Active challenges.
- Active restrictions.
- Pending notifications.
- Manual challenge-resolution state.
- Scores and score explanations.

All reducers must remain idempotent and ignore stale or duplicate sequences.

### 12. Authorization and RLS

Extend access rules for new card tables and manual-resolution actions.

Required isolation:

- Teams can read their own hand and deck-derived state.
- Game members can read game-level card plays and public notifications.
- Target teams can read their challenge details and submit manual confirmation or rejection.
- Admins can reset and override manual resolutions according to moderation rules.
- Clients cannot directly mutate card inventory, effects, claims, or score records.
- A client subscribed to one game cannot receive another game's card events or notifications.

### 13. Testing strategy

Add pure property tests for:

- Deck uniqueness and exhaustion.
- Draw-two/keep-one behavior.
- Hand-size limit.
- Power Hour draw override.
- Duplicate-target prohibition.
- Target-mode validation.
- Effect activation and expiry boundaries.
- One-shot effect consumption.
- Radius and distance comparisons.
- Next-claim restrictions.
- Happy Hour first-bonus uniqueness.
- Party Crasher phantom-share transitions.
- Patient Investor claim counting.
- Score-ledger conservation and deterministic recalculation.
- Event idempotency and ordering.

Add route/database tests for:

- Atomic card play plus event append.
- Rejected card play writes nothing.
- Cross-game target rejection.
- Unauthorized hand access.
- Manual challenge confirmation and rejection authorization.
- Claim rejection under active restrictions.
- Claim and effect race conditions.
- Admin challenge/reset behavior.

Add environment-gated integration tests for:

- Realtime card delivery.
- Target-only notification visibility.
- Cross-game isolation.
- Timer sweep behavior.

## Card Coverage Checklist

| Card | Primary backend requirements |
|---|---|
| Go Piss Girl | Team target, challenge, target confirmation, notifications |
| Crop Dusting | Bar target, physical-location input, 15-minute bar lock, notifications |
| Moneybags | Team target, manual confirmation of price-tag requirement |
| Use It or Lose It | Target challenge, forced hand resolution, discard/play cascade, claim block |
| Wired | Team target, confirmation, notifications |
| Art School Dropout | Three-color caster input, manual confirmation of different-location requirement |
| Broad Shoulders | Manual completion confirmation |
| Bird Guide | Caster duration 0-300 seconds, manual confirmation of target duration |
| Interested Buyer | Manual confirmation, document/photo alternative handled outside the app |
| Different Tastes | Cuisine input, manual confirmation of matching-continent requirement |
| Everyone's a Critic | Manual success/failure confirmation, 15-minute claim block on failure |
| Fairest of Them All | Immediate reactive play, challenge mirroring, shared resolution |
| Pioneer | Next-claim restriction, unclaimed/non-finish validation |
| Cancel Culture | Bar target, coordinate radius, delayed activation, timed regional lock |
| Spin Cycle | Last-claimed-bar lookup, target confirmation |
| Dirty Bird | Manual completion confirmation |
| Scenic Route | Finish-distance comparison, next-claim restriction |
| Insurance | Self-target, next-claim score protection |
| Happy Hour | Bar target, one-hour window, immutable +5 bonus, repeat bonus claim |
| Party Crasher | Bar target, phantom claimant scoring, dynamic four-team transition |
| Patient Investor | Self-target, four-subsequent-claims counter, immutable +6 |
| Power Hour | Persistent 20-minute draw override |
| Voted Off the Island | Four-team prerequisite, team-plus-bar target, claim removal, re-claim support |

## Recommended Delivery Order

### Phase 1: Shared card domain primitives

- Finalize card metadata and target/requirement schemas.
- Add deck seeding and inventory transitions.
- Define canonical card events.
- Replace the wireframe card identifier with real card-instance identifiers.
- Add pure tests for deck and hand invariants.

### Phase 2: Real card play and notifications

- Implement the transactional card-play route.
- Implement target validation and duplicate-target checks.
- Add challenge and confirmation records.
- Add target/non-target notification routing.
- Wire the board reducer to real card events.

### Phase 3: Claim restrictions and timers

- Add generic effects and active restriction queries.
- Integrate restrictions into the claim transaction.
- Implement Crop Dusting, Pioneer, Scenic Route, Everyone's a Critic, and Cancel Culture.
- Add server-time expiry and scheduled processing.

### Phase 4: Manual challenge resolution

- Add manual completion and rejection actions.
- Add admin reset/override actions and audit events.
- Support Moneybags, Art School Dropout, Bird Guide, Different Tastes, Broad Shoulders, Dirty Bird, and Interested Buyer through honor-system confirmation.

### Phase 5: Scoring and card-economy effects

- Add the score ledger.
- Implement Insurance, Happy Hour, Party Crasher, and Patient Investor.
- Implement Power Hour's draw override.
- Implement Use It or Lose It, Fairest of Them All, and Voted Off the Island.

### Phase 6: Full integration and moderation

- Add admin challenge/reset and override controls.
- Verify all card interactions under concurrent claims and plays.
- Complete realtime integration tests.
- Remove the wireframe route and placeholder hand only after the real path is proven.

## Open Decisions Before Implementation

These should be resolved in the relevant implementation spec before migrations are written:

- Whether card inventory is seeded at game creation or at game start.
- Whether random draw order is generated server-side once or derived from a stored seed.
- Whether target confirmation is required for all team challenges or only selected cards.
- What exactly constitutes a failed challenge and who may mark it failed.
- Whether an unresolved challenge blocks a team immediately or only after the current in-line exception ends.
- Whether score changes are materialized into a ledger, derived from events, or both.
- How Happy Hour's "first drink" is represented when the app cannot independently verify drinking.
- Whether distance uses straight-line geodesic distance or a walking-route distance.
- Whether timer activation is lazy, scheduled, or both.
- Which admin overrides can bypass card restrictions without invalidating the audit history.
