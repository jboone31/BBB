# UAT Feedback Requirements

This specification captures usability and game-flow feedback collected during
mobile-device UAT. The goal is to make the in-game experience consistent for
hosts and players on mobile and desktop, while preserving the game's real-time
team and game-state behavior.

## 1. Responsive Bar Selection

### 1.1 Start and finish bar menus

The controls used to select the start bar and finish bar must be available and
usable on mobile devices.

### 1.2 Mobile interaction

The start-bar and finish-bar dropdowns must open when tapped, remain within the
viewport, and allow the host to select an option without requiring hover,
desktop-only pointer behavior, or a separate device layout.

### 1.3 Validation

The same required-field validation and selected values must apply on mobile and
desktop.

## 2. Game-Start Navigation and Team Assignment

### 2.1 Automatic navigation when the game starts

When the host starts a game, every connected participant must be taken to the
game board automatically. This includes the host, who must not depend on a
separate “Go to game board” button.

### 2.2 New-player handling

A participant who has not selected a team must not be sent into a team-specific
game experience without first choosing a team. On game start, that participant
must be prompted to select an available team.

### 2.3 Navigation after team selection

After a new player selects a team successfully, the player must be taken
directly to the game board for that team.

### 2.4 Existing-player handling

A participant who already belongs to a team must bypass team selection and go
directly to the game board when the game starts or when they reconnect to an
active game.

### 2.5 Real-time consistency

Game-start navigation and team-assignment state must update for all relevant
connected clients through the existing real-time game-state mechanism. Refreshing
or reconnecting must not leave a participant stranded on the lobby screen.

## 3. Team Membership on the Scoreboard

### 3.1 Team rosters

The scoreboard must show the players currently assigned to each team.

### 3.2 Roster updates

Team rosters must update when a player joins, selects a team, changes teams
where allowed, or leaves the game. The display must distinguish teams clearly
and must not show a player under multiple teams.

### 3.3 Empty teams

Teams with no players must remain identifiable on the scoreboard and show an
appropriate empty-state indicator.

## 4. Ending an Active Game

### 4.1 Host end-game action

The host must have an explicit option to end the active game.

### 4.2 Confirmation

Selecting the end-game option must show a confirmation prompt before changing
the game state. Dismissing or cancelling the prompt must leave the game active.

### 4.3 End-game result

After confirmation, the game must transition to its ended state, stop accepting
normal in-game actions, and show the appropriate end-game/winner experience to
all connected participants.

### 4.4 Authorization

Only the host may end the game through this action. Non-host participants must
not see or be able to invoke the host end-game control.

## 5. In-Game Navigation Menu and Leaving a Game

### 5.1 Top-left navigation behavior

Clicking or tapping the top-left icon while in a game must not navigate directly
to the home screen.

### 5.2 In-game menu

The game screen must provide a menu in the top-right area. The menu must be
usable on mobile and desktop.

### 5.3 Leave-game action

The top-right menu must include a “Leave Game” option. The option must prompt
for confirmation before the participant leaves. Cancelling must keep the
participant in the game.

### 5.4 Host leave behavior

If the host chooses “Leave Game,” the confirmation prompt must explain that
leaving will end the game. Confirming must end the game for everyone, not merely
remove the host's player session.

### 5.5 Non-host leave behavior

When a non-host confirms “Leave Game,” that participant must leave the game and
be removed from the active team roster. The game must remain active for the
other participants.

## 6. Join-Code Visibility and Sharing

### 6.1 Persistent join-code visibility

The active game's join code must be visible in the top bar throughout the game so
players can provide it to people joining late.

### 6.2 Share action

The top-right in-game menu must include “Share Join Code,” positioned above
“Leave Game.”

### 6.3 Sharing interaction

Selecting “Share Join Code” must expose the existing supported sharing behavior
or a copy-to-clipboard fallback, and must make the code easy to recover if
sharing is unavailable or cancelled.

### 6.4 Security and lifecycle

The displayed and shared code must belong to the current game. Ending or
leaving the game must not make the ended game appear joinable as an active game.

## 7. Cross-Cutting Acceptance Criteria

- All new controls and prompts are accessible by keyboard and touch.
- Mobile layouts do not hide, clip, or place required controls outside the
  viewport.
- Loading, error, cancellation, and unauthorized-action states are explicit to
  the user; no action may appear successful if the server update failed.
- Existing game rules, scoring, bar-claim behavior, and real-time updates remain
  unchanged except where this specification explicitly changes lifecycle or
  navigation behavior.
- Automated tests cover the changed navigation, authorization, lifecycle, roster,
  and responsive interaction behavior, with focused manual verification on a
  mobile viewport.
