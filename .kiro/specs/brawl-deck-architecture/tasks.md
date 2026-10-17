# Brawl Deck Architecture Implementation Tasks

Implement the requirements in `requirements.md` by wiring the existing pure deck
engine (`lib/cards/deck.ts`), card catalog (`lib/cards/catalog.ts`), inventory
schema (`supabase/migrations/0009_card_inventory.sql`), and card-event projection
(`lib/gameboard/events.ts`) into the live game: draw on claim, a real hand with
keep/discard, real card play with team/bar targeting and eligibility graying, and
a PR-gated dev-only card-injection button.

This is largely an integration-and-UI effort on top of an existing engine, not a
from-scratch build. Scope is play + targeting + inventory becoming real; each
card's downstream gameplay effect is out of scope for this branch, but the seams
must leave room for them (notably Power Hour).

Design decisions (confirmed with the author):

- **Deck persistence (1=a):** the server rebuilds a team's `DeckState` inside the
  claim/keep/play transaction (reading `card_instances` / `team_decks`), applies
  a single pure engine transition, persists the resulting rows, and appends the
  matching `cards_drawn` / `card_kept` / `card_discarded` / `card_played` event.
  The pure engine stays the single source of truth for transitions; the event log
  stays authoritative.
- **Dev flag (2=a):** a committed TypeScript config module (e.g.
  `lib/config/devFlags.ts`) exporting a `DEV_CARD_INJECTION` boolean, checked both
  in the UI (to show the button) and server-side (to authorize the route), so the
  capability is truly off when false, not merely hidden.
- **Play scope (3=a):** build the full targeting UX against real `card_played`
  events (team graying for "no same-named card twice," bar graying for ineligible
  bars, team-then-bar for `team_and_bar`), replacing the wireframe path, without
  implementing each card's downstream effect.

## 1. Branch setup

- Inspect `feature/dev-mode` (log and diff against its base) to determine whether
  its commits are worth preserving.
- Create `feature/brawl-deck-architecture` at `feature/dev-mode`'s tip to preserve
  its commits (or from the shared base if the branch has nothing meaningful), then
  delete `feature/dev-mode` locally.
- Do not force-push; keep the branch operations local unless the author asks to
  update the remote.
- Verify the working tree builds and the default hermetic test run is green on the
  new branch.

## 2. Committed dev-flag config module

- Add `lib/config/devFlags.ts` exporting `DEV_CARD_INJECTION` (default `false`)
  with a typed accessor, following the existing `lib/` module conventions.
- Record that this file is PR-controlled: flipping the constant simulates dev vs.
  prod mode (R5.1).
- Add unit tests proving the accessor reads the constant and that flipping it
  flips the reported value. No behavior is wired to the flag yet.
- Update `structure.md` if a new top-level `lib/config/` surface is introduced.

## 3. Server deck persistence helper

- Build a transactional helper (e.g. `lib/cards/persistence.ts` or a
  `lib/db` deck repository) that, inside a transaction, loads a team's
  `DeckState` from `card_instances` / `team_decks`, seeding on first touch via
  `seedDeck`, applies a single pure engine transition, persists the resulting
  card-instance / deck rows, and appends the matching canonical event via the
  existing `appendEvent` (R4.1, R4.2).
- Keep the pure engine (`lib/cards/deck.ts`) authoritative for transitions; the
  helper only maps between durable rows and `DeckState` and records the event.
- Preserve the Power Hour draw-override seam so future effects can set it without
  a schema change (R4.3).
- Add unit/integration tests (hermetic where possible, live via
  `npm run test:integration` where a DB is required) covering seed-on-first-touch,
  draw, keep, discard, and play round-trips.

## 4. Draw-on-claim wiring in the claims route

- Extend `app/api/games/[gameId]/claims/route.ts` so a successful first claim of a
  non-finish bar triggers a draw within the same transaction as the claim and its
  scoring (R1.1, R1.6).
- Do not draw on the finish bar; preserve the immediate game-end transition there
  (R1.3). Do not re-draw a bar the team has already drawn from, using
  `card_draws` / `drawnBarIds` (R1.4). Handle deck exhaustion and the single-card
  case (R1.5).
- Append `cards_drawn` alongside the existing `claim_recorded` and score events so
  the draw is part of the same atomic commit.
- Add route tests: claiming a scoring bar writes claim + score + `cards_drawn`
  atomically; claiming the finish bar ends the game with no draw; a repeat
  encounter of an already-drawn bar produces no new draw.

## 5. Keep and discard server routes

- Add authorized, transactional routes to resolve a pending draw (`keepCard`) and
  to discard a held or pending card (`discardCard`), each appending `card_kept` /
  `card_discarded` (R1.2, R2.4).
- Enforce that a pending draw is resolved before the team's next draw, consistent
  with the engine's `pending_draw` / `card_not_pending` rejections.
- Add route tests: keep moves exactly one pending card to `hand` and discards the
  rest; discard from a full hand frees a slot; the board projection reflects both.

## 6. Draw-choice UI on the board

- Replace the placeholder hand path on the board with the real
  `GameBoardView.cards` for the current team (R2.1).
- When a draw is pending, present the two drawn cards with their catalog text and
  a keep action (keeping one discards the other — R1.1, R1.2).
- Handle the hand-full case by prompting the team to play or discard an existing
  card before the new card is added (R2.4).
- Add component tests: claim surfaces two real cards; keeping one lands it in hand
  with the other discarded; a full hand forces a play/discard first.

## 7. Hand inspection and card detail

- Render the real hand (max two) from the projection (R2.3).
- Selecting a held card shows its real name, catalog text, and playing
  requirements (R2.2).
- Add component tests for inspecting a held card's details.

## 8. Real play route and team targeting with eligibility

- Replace `app/api/games/[gameId]/wireframe-card-play` with a real play path that
  writes a `card_played` event carrying the chosen target(s) and removes the card
  from the hand (R3.1).
- Enforce "no team targeted by a card of the same name more than once" on the
  server (R3.3).
- Add pure eligibility selectors in `lib/gameboard/` that derive, from the folded
  state, which teams are ineligible for a given card; gray out and disable those
  teams in the play UI (R3.2, R3.3).
- Add route, selector, and component tests: playing a team-targeting card records
  `card_played`, notifies the target in near real time (R3.7), and already-
  same-card-targeted teams are grayed and unselectable.

## 9. Bar targeting on the map (and team-and-bar)

- For bar-targeting cards, open the map to select a bar, graying out and disabling
  ineligible bars using an eligibility selector derived from folded state
  (R3.4, R3.5).
- For `team_and_bar` cards, prompt for the bar first and then the team (R3.6).
- Wire both into the real play route and `card_played` payload.
- Add tests for the bar-eligibility selector and the map selection flow, including
  the team-then-bar ordering.

## 10. Dev-only "add card to hand" button and inject route

- Add a server route that injects a chosen card slug into a team's hand, ignoring
  the hand-size limit, authorized only when `DEV_CARD_INJECTION` is true
  (server-enforced — R5.2, R5.3).
- Surface the inject button on the board only when the flag is on (R5.2).
- Add route tests proving the capability is fully refused (no-op / error) when the
  flag is false, not merely hidden, and that it bypasses the hand limit when on.

## 11. Cleanup and full verification

- Remove the now-dead `lib/gameboard/placeholderCards` and the
  `wireframe-card-play` route and their references once nothing depends on them.
- Run the full default hermetic test suite plus type-check, lint, and formatting;
  run the live integration suite (`npm run test:integration`) where a DB is
  available.
- Confirm steering `cards.md` and `structure.md` still match reality (note any
  new config directory or route/event names).
- Exercise end-to-end on one game: claim -> draw -> keep -> inspect -> play (team
  and bar targeting) -> dev-inject, confirming the wireframe path is gone and the
  build and tests are green.
