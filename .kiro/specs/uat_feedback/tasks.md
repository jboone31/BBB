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

## 2. Fix start/finish bar selection on mobile

- Replace or adapt desktop-only dropdown behavior so start-bar and finish-bar
  selectors open and operate from touch input.
- Ensure the menu is positioned within the mobile viewport and is not clipped by
  an overflow or stacking context.
- Preserve the existing option values, validation, loading states, and
  start-game request payload.
- Add component tests for opening and selecting both controls with mobile-sized
  rendering, plus regression coverage for desktop selection.

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
