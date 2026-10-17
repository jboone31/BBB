# Brawl Deck Architecture Requirements

This specification wires the existing-but-dormant Brawl Deck engine into the
live game. Claiming a non-finish bar must draw cards and prompt a keep/discard
choice; kept cards enter a real hand that can be inspected and played with
correct team/bar targeting and eligibility; hand-size limits force a
play-or-discard before a new card is added; and a PR-gated dev-only button can
inject specific cards for testing.

Scope is **play + targeting + inventory becoming real** against real
`card_played` events. It does **not** include implementing each card's
downstream gameplay effect (e.g. the actual point/claim consequences of Happy
Hour, Insurance, Party Crasher, etc.); those remain a later per-card effort. The
architecture must, however, leave clean seams for those effects — notably
Power Hour's draw-both behavior, which the engine already models.

## Background: what already exists

Most of the deck "architecture" already exists as pure, tested domain code and
schema; it is simply not wired into the running app.

- `lib/cards/deck.ts` — the pure deck engine: `seedDeck`, `drawForBar`
  (draw two into `pending`, honoring finish-bar / duplicate-bar / hand-full /
  deck-exhausted rejections and Power Hour keep-both), `keepCard`,
  `discardCard`, `playCard`, and `activatePowerHour`.
- `lib/cards/catalog.ts` — all 23 cards with `targetMode`
  (`team` / `bar` / `self` / `none` / `team_and_bar` / `reactive`), casting
  inputs, and domain families.
- `supabase/migrations/0004_cards.sql`, `0005_seed_card_catalog.sql`, and
  `0009_card_inventory.sql` — `card_instances`, `team_decks`, and `card_draws`
  tables with team-scoped RLS (clients read only their own inventory; writes are
  server-only).
- `lib/gameboard/events.ts` — `GAME_BOARD_EVENT_TYPES` already defines
  `deck_seeded`, `cards_drawn`, `card_kept`, `card_discarded`, and `card_played`,
  and `applyCardInventoryEvent` already folds them into per-team `BoardCardView`
  entries (`deck` / `pending` / `hand` / `played` / `discarded`).

What is missing is integration and UI: nothing imports the deck engine (it is
referenced only by its own tests), the claims route never triggers a draw, the
board renders a fake `placeholderHand` and plays through the no-op
`wireframe-card-play` route, and there is no committed config pattern for a
PR-gated flag.

## 1. Draw on Claim

### 1.1 Draw on first claim of a scoring bar

When a team successfully claims a non-finish bar for the first time, the team
must draw the top two cards of its deck and be prompted to keep one.

### 1.2 Keep one, discard the rest

From a pending draw, the team keeps exactly one card; every other card in that
draw is permanently discarded and removed from play for the rest of the game.

### 1.3 Finish bar draws nothing

Claiming the finish bar must still end the game immediately and must not trigger
a draw.

### 1.4 One draw per unique bar

A bar that a team has already drawn from must not produce another draw if
re-encountered. Draw is once per team, per unique bar.

### 1.5 Deck exhaustion

A team whose deck is empty may still claim bars but draws no cards. If exactly
one card remains, that card may be added to the hand directly.

### 1.6 Atomicity

The claim, its scoring, and the resulting draw must commit together in a single
transaction. A failure in any part writes none of them.

## 2. Hand and Card Inspection

### 2.1 Real hand from authoritative state

The board must render the current team's real hand, derived from the folded
game-event projection, replacing the placeholder hand.

### 2.2 Card detail

Selecting a held card must show its real catalog text and playing requirements.

### 2.3 Default hand limit

A team may hold at most two cards (the default maximum hand size).

### 2.4 Play-or-discard before draw

If a team is at the maximum hand size when a new card would be added, the team
must be prompted to play or discard an existing card first, before the new card
enters the hand.

## 3. Playing Cards and Targeting

### 3.1 Real card play

Playing a card must write a real `card_played` event carrying the chosen
target(s), replacing the wireframe card-play path. Once played, the card is
removed from the team's hand for the rest of the game.

### 3.2 Team targeting

When a card targets a team, the player must choose a target team at play time.

### 3.3 Team eligibility and graying

A team that cannot be targeted for any reason — including a team already targeted
by a card of the same name — must be shown as grayed out and must not be
selectable.

### 3.4 Bar targeting

When a card targets a bar, the player must be shown the current state of the map
to select the target bar.

### 3.5 Bar eligibility and graying

A bar that cannot be targeted must be shown as grayed out and must not be
selectable on the map.

### 3.6 Combined team-and-bar targeting

When a card targets both a bar and a team, the player must be prompted to select
the bar first and then the team.

### 3.7 Real-time delivery

A played card and its targeting must propagate to the relevant clients through
the existing real-time event mechanism, so targeted teams see it without a
refresh.

## 4. Deck Architecture and Future Effects

### 4.1 Engine as source of truth

Deck transitions (draw, keep, discard, play) must be driven by the pure
`lib/cards/deck.ts` engine. The server rebuilds a team's deck state inside the
transaction, applies one engine transition, persists the resulting rows, and
appends the matching canonical event.

### 4.2 Event log authoritative

The append-only game-event log remains the authoritative record of inventory
state. The board projection folds those events; no parallel client-only hand
source is introduced.

### 4.3 Room for future behaviors

The draw/keep/discard/play seams must accommodate future card behaviors without a
schema rewrite — in particular Power Hour's "draw two, keep both" draw override,
which the engine already models.

## 5. Dev-Only Card Injection

### 5.1 PR-gated parameter

A committed configuration parameter (not an environment variable) must toggle a
dev-only "add card to hand" capability. Changing it requires a code edit and a
pull request, simulating dev mode versus prod mode.

### 5.2 Inject button

When the parameter is on, the board must expose a dev-only control to add a
specific card to the current team's hand for testing. This control may ignore
the hand-size limit.

### 5.3 Server enforcement

The injection capability must be enforced on the server, not merely hidden in the
UI. When the parameter is off, the injection route must refuse the operation even
if called directly.

## 6. Cross-Cutting Acceptance Criteria

- New controls and prompts are accessible by keyboard and touch, and fit a mobile
  viewport without clipping (consistent with existing board surfaces).
- Loading, error, cancellation, and ineligible-target states are explicit to the
  user; no action may appear successful if the server update failed.
- Existing claim, scoring, lifecycle, and real-time behavior remain unchanged
  except where this specification explicitly adds draw-on-claim and real card
  play.
- The now-dead placeholder hand and wireframe card-play paths are removed once
  nothing depends on them.
- Automated tests cover draw-on-claim, keep/discard, hand-limit resolution,
  team and bar targeting with eligibility graying, the dev-injection flag's
  server enforcement, and the deck engine integration, with the default
  hermetic test run staying offline.
