# UAT Feedback Implementation Tasks

Implement the requirements in `requirements.md` as a coordinated update to the
game setup, active-game shell, navigation state, team membership, and game
lifecycle behavior.

## 1. Inspect and map existing behavior

- Identify the setup form and start/finish bar controls, including their mobile
  rendering and event handlers.
- Trace game-start state propagation from the host action through Supabase
  Realtime subscriptions and client navigation.
- Identify the active-game layout, current top-left navigation control,
  scoreboard, team/player data model, join-code source, and existing share
  utilities.
- Identify existing game-end, leave-game, confirmation-dialog, authorization,
  and cleanup patterns before adding new handlers.
- Document any missing server-side state transitions or realtime events needed by
  the tasks below.

### Task 1 findings

**Current surfaces and behavior**

- Setup and bar designation are composed by
  `app/games/[gameId]/lobby/page.tsx` using
  `components/lobby/CreateGame.tsx`. The two bar controls are text inputs backed
  by a shared HTML `datalist`, not native `select` elements. The page sends
  designation requests to `POST /api/games/[gameId]/bars`.
- The host start control is `components/lobby/StartGame.tsx`. The lobby page
  sends `POST /api/games/[gameId]/start`; the route authorizes the admin,
  validates the team/bar gates, updates `games.lifecycle` to `live`, and
  appends one `game_started` event atomically.
- Lobby state is folded by `lib/lobby/events.ts`. It already represents teams,
  players, nullable team membership, join code, and the `game_started` lifecycle
  transition. `team_changed` updates a player and removes that player from all
  previous team rosters in the folded view.
- The lobby page currently renders a manual `Go to game board` link whenever the
  folded lifecycle is `live`; it does not automatically navigate the host or
  other connected participants.
- The board page uses `lib/gameboard/access.ts`. A live board requires a
  resolved session that is either the game admin or a player. A teamless player
  is currently redirected to the lobby, where live team selection is allowed.
  Selecting a team does not currently navigate the player back to the board.
- The board page renders `components/board/ScoreboardRegion.tsx` with teams,
  scores, and claimed-bar counts only. It does not pass player membership data.
- Host end-game functionality already exists at
  `POST /api/games/[gameId]/end`, using `lib/gameend/transition.ts` to atomically
  set `ended`, set `end_reason`, and append `game_ended`. There is no active-board
  host control or confirmation flow wired to this route yet.
- The root `components/shell/HeaderNav.tsx` wraps the logo/tagline in a link to
  `/`. The board page has no replacement top-right in-game menu, leave-game
  action, or leave confirmation flow.
- Join-code generation and sharing primitives exist under `lib/lobby/` and the
  lobby roster has sharing coverage, but the board page has no persistent join
  code in its top bar and no in-game “Share Join Code” menu action.

**Existing server and realtime seams to reuse**

- Server writes consistently use `withTransaction` plus `appendEvent`, so end
  game and future leave-game mutations should follow that atomic pattern.
- `POST /api/games/[gameId]/join` creates a teamless player and appends
  `player_joined`; it permits joining a live game.
- `POST /api/games/[gameId]/teams/select` updates a player's single `team_id`
  and appends `team_changed`; it permits selection/switching during a live game.
- The event log is the shared realtime transport. `game_started` is currently
  understood by the lobby fold and `game_ended` by the game-end/board flow.
  There is no player-left event or leave-game route.
- Durable browser facts are currently `bbb:admin:{gameId}` and
  `bbb:player:{gameId}`. They are useful for existing-session routing but are not
  sufficient by themselves to resolve a newly joined live player after reload;
  routing must also use the authoritative folded membership snapshot.

**Implementation dependencies and gaps**

1. First adapt the lobby/board routing state so `game_started` causes automatic
   navigation, while a teamless live player is routed to team selection and a
   selected player is routed to the board.
2. Reuse the folded player/team data for scoreboard rosters and team-selection
   resolution; do not add a parallel client-only roster source.
3. Add a player-leave mutation and event before wiring the leave menu, including
   the host-leaves-to-end behavior. The explicit host end action can reuse the
   existing end route/helper.
4. Add the board shell menu and join-code presentation after the routing and
   lifecycle state are authoritative, so menu actions cannot operate on stale
   game identity.
5. Replace or augment the `datalist` bar inputs with a touch-safe picker as part
   of the mobile bar-selection task; the current HTML `datalist` behavior is
   browser-dependent on mobile.

**Relevant existing tests**

- Lobby orchestration/navigation coverage is in
  `app/games/[gameId]/lobby/page.orchestration.test.tsx` and
  `app/games/[gameId]/lobby/page.board-nav.test.tsx`.
- Board access and lifecycle coverage is in
  `app/games/[gameId]/board/page.test.tsx`.
- Lobby event folding is covered by
  `lib/lobby/events.property.test.ts` and related lobby tests.
- End-game transition and route behavior are covered by
  `lib/gameend/atomicEnd.property.test.ts`,
  `app/api/games/[gameId]/end/route.ts`, and existing integration suites.

## 2. Fix start/finish bar selection on mobile

- Replace or adapt desktop-only dropdown behavior so start-bar and finish-bar
  selectors open and operate from touch input.
- Ensure the menu is positioned within the mobile viewport and is not clipped by
  an overflow or stacking context.
- Preserve the existing option values, validation, loading states, and
  start-game request payload.
- Add component tests for opening and selecting both controls with mobile-sized
  rendering, plus regression coverage for desktop selection.

### Task 2 implementation notes

- `components/lobby/CreateGame.tsx` now uses explicit application-rendered bar
  option menus instead of relying on mobile browser `datalist` UI.
- The menus use touch-sized buttons, bounded scrolling, viewport-safe width,
  keyboard-focusable native buttons, and retain editable text inputs so the
  existing candidate-bar validation and submission payload remain unchanged.
- `components/lobby/CreateGame.test.tsx` covers opening and selecting both the
  start-bar and finish-bar menus.
- `components/lobby/CreateGame.property.test.tsx` now includes the candidate-bar
  catalog rule in its oracle, so generated non-candidate names are correctly
  expected to be rejected.

### Task 3 implementation notes

- `app/games/[gameId]/lobby/page.tsx` now automatically replaces the lobby route
  with `/games/{gameId}/board` after a live lifecycle is folded for an admin or
  a player whose team membership is resolved.
- Teamless live players remain on the lobby team-selection surface rather than
  being routed into team-specific board play. A successful live
  `teams/select` response immediately routes that player to the board.
- The former `Go to game board` link has been removed; this prevents the host
  from being stranded on the lobby and removes the mobile-only extra action.
- `page.board-nav.test.tsx` now covers automatic admin routing, teamless-player
  retention for team selection, and existing-player routing after team
  membership is folded. Existing board access and lobby orchestration suites
  continue to pass.

## 3. Implement game-start routing and team-selection flow

- Define the client-visible game phases needed to distinguish lobby, active game,
  ended game, and an active participant with no team.
- Update the game-start realtime handling so every connected participant,
  including the host, automatically transitions away from the lobby.
- Route existing team members directly to their team game board.
- Route participants without a team to a team-selection prompt, then navigate
  them directly to the selected team's game board after a successful assignment.
- Handle refresh and reconnect during an active game using server-backed game and
  membership state rather than only transient client state.
- Add authorization and error handling for team assignment, including unavailable
  teams and failed requests.
- Add unit/component tests for host, existing player, new player, reconnect, and
  failed-assignment paths.

## 4. Expose team rosters on the scoreboard

- Extend the scoreboard data query or realtime projection to include the players
  assigned to each team.
- Render a clearly labeled roster for every team, including an explicit empty-team
  state.
- Ensure the same player cannot render under multiple teams and that display names
  are handled consistently with existing player identity rules.
- Subscribe to the relevant membership events so joins, assignments, changes, and
  departures update without a full-page refresh.
- Add tests for populated teams, empty teams, membership updates, and stale or
  duplicate membership data.

### Task 4 implementation notes

- `GameBoardView` now folds `player_joined`, `team_changed`, and `player_left`
  events into a canonical player projection, so initial snapshots and realtime
  updates use the same membership state.
- `ScoreboardRegion` renders each assigned player's display name under the
  corresponding team, deduplicates repeated player records, and shows an
  explicit empty-team state.
- Membership projection and scoreboard coverage includes populated teams,
  empty teams, duplicate membership data, unavailable team assignments, and
  departures.

## 5. Add host end-game action

- Add a host-only “End Game” control to the active-game interface.
- Reuse the project confirmation-dialog pattern, with copy that explains the
  impact and supports cancellation without mutation.
- Implement an authorized server/domain transition to the ended state and append
  the corresponding realtime game event atomically with the state change.
- Make all clients respond to the ended state by disabling normal game actions and
  showing the existing or newly defined end-game/winner experience.
- Make repeated submissions idempotent and show explicit errors when the
  transition fails.
- Add authorization, route/domain, realtime, and UI tests for host success,
  non-host denial/absence, cancellation, repeated requests, and failure.

### Task 5 implementation notes

- The active board now exposes a host-only `End Game` action with a touch-sized
  confirmation dialog explaining that gameplay stops for everyone and the final
  scores become read-only.
- The action reuses `POST /api/games/{gameId}/end`, whose existing transaction
  and authorization path atomically writes `ended` plus `game_ended`; the client
  prevents concurrent submissions, closes the dialog on success, and surfaces
  explicit mutation failures.
- Existing `game_ended` folding makes every subscribed client enter the
  read-only board state, disabling claims and card play while retaining the map
  and scoreboard for final inspection.
- Board coverage includes host cancellation and success, non-host control
  absence, and failed end requests.

## 6. Replace top-left home navigation with the in-game menu

- Remove the direct home navigation from the top-left in-game icon while
  preserving any intended visual affordance or replacing it with the approved
  in-game navigation treatment.
- Add a touch- and keyboard-usable menu in the top-right of the active-game shell.
- Add “Share Join Code” above “Leave Game” in the menu.
- Add confirmation flows for leaving:
  - Non-host copy explains that only the participant will leave.
  - Host copy clearly states that leaving will end the game for everyone.
- Implement non-host leave as an authorized membership/session removal and ensure
  the player disappears from team rosters.
- Implement host leave by invoking the same authoritative end-game transition
  used by the explicit end-game action, then remove or close the host session as
  appropriate.
- Close the menu and clear pending state after cancellation, success, or a
  surfaced failure.
- Add tests for menu ordering, touch interaction, keyboard access, both
  confirmation variants, cancellation, non-host leave, and host leave.

## 7. Display and share the join code

- Add the current game's join code to the active-game top bar with a mobile-safe
  layout that does not obscure score or navigation controls.
- Wire “Share Join Code” to the supported Web Share API when available and to a
  copy-to-clipboard fallback when it is not.
- Provide visible success and failure feedback, and keep the code recoverable
  after a cancelled or failed share.
- Verify that the code is read from the current game's authoritative state and
  is not stale after navigation or reconnect.
- Prevent ended games from being represented as active join targets.
- Add tests for top-bar rendering, share success, share cancellation/failure,
  clipboard fallback, and active-game identity.

## 8. Validate integration and mobile UX

- Run focused unit/component tests for all changed modules, then run the existing
  project lint, type-check, and relevant integration tests.
- Exercise host and player flows with at least one mobile viewport:
  setup bar selection, host game start, new-player team selection, scoreboard
  rosters, share join code, non-host leave, host leave, explicit end game, and
  reconnect during an active game.
- Verify realtime behavior with multiple clients so game start, roster changes,
  end-game transitions, and host departure converge for everyone.
- Update directly related user-facing documentation or developer notes if the
  final implementation introduces new route, event, or state names.
