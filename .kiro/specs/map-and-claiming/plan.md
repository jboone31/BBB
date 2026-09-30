# Map And Claiming Plan

This plan describes the durable bar-claiming, scoring, finish-bar, and map wiring work for roadmap section 2. It follows the existing BBB architecture and the finalized rules in `.kiro/steering/game-rules.md` and `.kiro/steering/cards.md`.

The implementation must preserve:

- Next.js App Router and TypeScript.
- Supabase Postgres as the source of durable game state.
- `postgres.js` for server-side transactional mutations.
- Supabase Realtime over the append-only `game_events` table.
- Per-game session identity and RLS isolation.
- Pure, framework-free domain logic with Vitest and fast-check coverage.
- The existing in-house candidate-bar catalog and Leaflet/OpenStreetMap map.

## Goals

The section 2 implementation must support:

- A durable claim mutation path owned by the server.
- Trusted claim-time attestation that all team members are present and at least half have finished a drink.
- Reversible active claims for accidental undo and future Voted Off the Island behavior.
- Start-bar zero points, ordinary bar share recomputation, and finish-bar solo scoring.
- An append-only score adjustment ledger that retains historical corrections.
- Atomic domain state plus canonical claim, score, and game-end events.
- Realtime map marker and scoreboard updates for all clients in the game.
- Snapshot/reconnect behavior equivalent to ordered realtime delivery.

## Current Foundation

Already present in the repository:

- Candidate bar catalog in `lib/map/bars.ts`.
- Client-only Leaflet map with catalog-bound initial viewport, pan/zoom, and marker popups.
- Durable `claims` table with game/team/bar foreign-key integrity and duplicate protection.
- `games.lifecycle` with `lobby`, `live`, and `ended` states, plus `finish_bar_id` and `end_reason`.
- Append-only ordered `game_events` with transaction-scoped `appendEvent`.
- Realtime snapshot, ordering, deduplication, reconnect, and resume infrastructure.
- Pure share calculation in `lib/scoring`.
- Pure game-end transition support in `lib/gameend`.
- Board event types for claims, scores, and game ending.
- Map and scoreboard wireframes that currently use local or placeholder state.

The current claims table is the durable foundation but does not yet represent active versus revoked claims. The current map does not perform server mutations, and the board reducer ignores claim events for domain state.

## Locked Product Decisions

1. **Claim-time honor system:** The claim request itself attests that all team members are present and that at least half the team finished a drink. No separate drink-completion or presence table is required for section 2.
2. **Half-team threshold:** Eligibility is `ceil(current assigned team members / 2)`. Teamless players are excluded from the claiming team count. A team with no assigned members cannot claim.
3. **Reversible claims:** A team's active claim can be revoked by that team's own ordinary undo action or by a future authorized card effect. A later claim creates a new active transition and recomputes the bar shares.
4. **No finish-bar undo:** A successful finish-bar claim ends the game immediately. It cannot be undone after the transaction commits.
5. **Score representation:** Use an immutable append-only adjustment ledger. Claim transitions append base awards or correction entries; historical entries are never rewritten. Current totals are deterministic sums of applicable entries.
6. **Claim order:** Claim order does not affect the final split, but every transition is recorded in event sequence order for realtime propagation and audit history.
7. **Server authority:** The browser never directly writes claims, scores, or game lifecycle state. It submits a mutation and waits for the committed event.
8. **Card extensibility:** Claim operations expose an authorization/effect hook for future restrictions and Voted Off the Island. Card-specific enforcement remains outside this section.

## Domain Model

### Active claim state

The durable claim representation must distinguish current active claims from revoked history. The preferred shape is a claim row with lifecycle fields such as:

- `id`
- `game_id`
- `team_id`
- `bar_id`
- `claimed_at`
- `revoked_at` or equivalent active status
- `revoked_reason` or equivalent source metadata

The database must enforce at most one active claim for a `(game_id, team_id, bar_id)` pair while allowing historical revoked rows and later reclaims. A partial unique index or an equivalent current-state table plus history model is acceptable if it preserves the same contract.

### Score adjustment ledger

The ledger must retain each score effect and correction rather than mutating earlier awards. Each entry should include:

- `id`
- `game_id`
- `team_id`
- `bar_id` when bar-derived, otherwise nullable
- `source_claim_id` or source transition identifier
- `category` such as `bar_share`, `bar_share_correction`, `finish_award`, or `card_modifier`
- signed `points`
- server timestamp
- optional metadata needed to explain the correction

Normal non-finish bar transitions should produce net totals matching the active claimant set. The implementation may append a correction for each affected team whenever claimant count changes. Start-bar entries are zero-point entries or omitted according to the chosen event contract, but must never award points.

## Mutation Contract

Add a claim mutation route under `app/api/games/[gameId]`, following the response and authorization patterns established by the neighboring game routes.

A successful response should identify the committed event sequence and mutation result:

```ts
type ClaimMutationResponse<Result = unknown> =
  | { applied: true; seq: number; result: Result }
  | { applied: false; error: StableMutationError; details?: Record<string, unknown> };
```

The request must carry an explicit action, such as `claim` or `unclaim`, and a bar id. The server derives the player and team from the session. The client cannot select another team for the mutation.

Successful claim behavior:

1. Require a valid active session and game membership.
2. Require the game to be live.
3. Resolve the player's current team and count its currently assigned members.
4. Apply the trusted half-team and presence attestation contract.
5. Validate that the bar belongs to the same game and is claimable.
6. Lock the game and relevant claim rows for the transaction.
7. Insert a new active claim transition.
8. Append score ledger entries or corrections.
9. Append the canonical claim event and score events.
10. For a finish bar, append the solo award and `game_ended`, then transition the game to ended.
11. Commit all changes together and return the final sequence/result.

Successful unclaim behavior:

1. Require the active claim to belong to the requesting player's team.
2. Reject unclaiming a finish claim or any claim after the game has ended.
3. Revoke the active claim with a source/reason.
4. Append inverse/recomputed ledger adjustments.
5. Append `claim_removed` and score events in the same transaction.
6. Return the committed sequence/result.

Rejected mutations write no domain row, ledger entry, or event. Stable errors should cover missing session, not-member, not-authorized, invalid input, not-found, conflict, blocked, and unavailable cases as appropriate.

## Event Contract

Use the existing board event vocabulary:

- `claim_blocked`
- `claim_recorded`
- `claim_removed`
- `score_awarded`
- `score_modifier_applied`
- `game_ended`

Claim payloads must contain enough information for a client reducer to reconstruct current active claim state without querying another endpoint. Score payloads must identify the team, points, category, bar/source, and ledger identity. Finish `game_ended` payloads must identify `finish_bar_claimed` and the claiming team actor.

Events are propagation and audit history, not the sole source of current state. Durable claims and ledger rows remain authoritative for server reads; the board fold reconstructs the realtime client view.

## Transaction And Concurrency Rules

- Lock the game row before evaluating lifecycle and finish-bar transitions.
- Serialize claim/unclaim updates for the affected game/bar.
- Use the active-claim uniqueness constraint as a final duplicate guard.
- A second finish-bar request must observe `ended` or lose the active transaction race and receive a conflict; it must not award points or append a second end event.
- Domain writes, ledger writes, and event writes must share one `withTransaction` call.
- If any event append fails, every claim, score, and lifecycle write rolls back.

## Board And UI Contract

Extend `GameBoardView` with reducer-derived active claims and score totals or the inputs needed to derive them. The fold must:

- Apply `claim_recorded` and `claim_removed` to active claims by bar/team.
- Apply score events idempotently by event sequence and ledger identity.
- Preserve ordered application, stale-event ignoring, duplicate tolerance, and game isolation.
- Produce the same state from an initial snapshot and from the equivalent realtime tail.

`app/games/[gameId]/board/page.tsx` becomes the owner of durable board state. `MapRegion` must no longer create its own authoritative claim state. `BarLeafletMap` receives reducer-derived claim segments and a mutation callback.

The map must:

- Render every candidate bar from the existing catalog.
- Show all active claiming teams in marker color segments.
- Allow only the current player's team to claim or undo its own claim.
- Show pending, failure, and disabled states without optimistic durable state that can drift from the event log.
- Preserve Leaflet client-only loading and current viewport behavior.

The scoreboard must:

- Render live team totals, including zero.
- Render each team's active claimed-bar count.
- Update from realtime events without requiring region navigation or remounting.
- Preserve existing colors, responsive layout, and accessibility behavior.

## Explicitly Out Of Scope

- Automated drink, presence, photo, or location validation.
- Card-specific blockers and score effects beyond claim-state hooks.
- Card draws triggered by claims.
- Player-proposed bars or admin catalog editing.
- Public photo feeds.
- Full game-end results, moderation, and final branding work from section 4.

## Release Gates

The feature is complete when:

1. Pure claim/scoring tests pass for thresholds, active transitions, share corrections, zero-point start claims, and finish awards.
2. Migration/schema/RLS checks pass for active/revoked claims and ledger integrity.
3. Route integration tests prove authorization, duplicate handling, rollback, unclaim/reclaim, and finish serialization.
4. Reducer tests prove snapshot/realtime equivalence, idempotency, and cross-game isolation.
5. Component/page tests prove durable map mutations, marker segmentation, scoreboard totals, and ended-game rendering.
6. Focused, typecheck, lint, and full test commands pass, with any environment-gated Supabase realtime limitation explicitly recorded.
