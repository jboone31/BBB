# Requirements Document

## Introduction

This feature refines the existing **Game Setup & Lobby** feature (the create/join/team-select/start
lifecycle implemented in `.kiro/specs/game-setup-lobby`) with three tightly scoped fixes to the
lobby's host, player, and code-sharing experience. It modifies the lobby client surfaces
(`components/lobby/CreateGame.tsx`, `components/lobby/JoinGame.tsx`, the lobby roster, and the
lobby page `app/games/[gameId]/lobby/page.tsx`) without changing any server route. It reuses the
established session-based Identity_Model (the `x-bbb-session-id` header), the append-only
`game_events` log, and the app-shell Share_Link model (`/games/{gameId}/lobby?code={code}`)
introduced in `.kiro/specs/app-shell-navigation`.

The three fixes are:

- **Fix 1 — Host becomes a Player (client-side).** Today an Admin creates a Game but never
  becomes a Player, so the host cannot pick a Team. This feature adds a required display-name
  field to the create-game surface and, after the create succeeds, has the Lobby_Client
  immediately join the Game as the host using the returned Join_Code and the idempotent
  `(game_id, session_id)` join semantics. No server route changes; the second request reuses the
  existing join route. Because create-then-join is two requests, the feature defines recovery
  when the create succeeds but the host-join does not.
- **Fix 2 — Separate "join a game" (enter via code) from "join a team".** The code-entry
  `Join_Game_Form` must render only for a visitor who has no Player row for the Game. Anyone who
  already has a Player row (the host or any joined Player) sees the team pipeline, never the
  code-entry form. This also removes the current defect where the host sees the code-entry form
  after creating a Game.
- **Fix 3 — Surface the Join_Code and a shareable link with copy affordances.** The lobby shows
  both the Join_Code and a Share_Link (the id-carrying lobby URL with the code embedded so a
  recipient lands with the code prefilled), each with a copy-to-clipboard control, while keeping
  the Join_Code visible as text.

**Scope boundaries.** This feature changes only the three behaviors above. It reuses the existing
`lib/lobby` validators (`validateDisplayName`, and the `joinCode` normalize/validate helpers) and
the existing server join route and its idempotency. It introduces no new server routes, no schema
changes, and no changes to team creation, bar designation, start, realtime propagation, or session
persistence beyond what these three fixes require. Server-side recovery or transfer of Admin
authority remains out of scope (as in the base feature).

## Glossary

- **Game:** A single BBB match with a `lifecycle` of `lobby`, `live`, or `ended`, as defined by
  the base Game Setup & Lobby feature.
- **Lobby:** The `lifecycle = 'lobby'` phase of a Game.
- **Admin:** The host Session that created a Game, identified by `games.admin_session_id`. Exactly
  one Admin per Game.
- **Player:** A participant identified by a Session that has joined a Game, represented by a row in
  the `players` table. After this feature, the Admin is also a Player.
- **Session:** The per-device, session-based identity of an Admin or Player, presented on requests
  via the `x-bbb-session-id` header, consistent with the base Identity_Model.
- **Join_Code:** The short shareable code recorded on `games.join_code`, 6 to 12 alphanumeric
  characters after normalization (trim + uppercase), matching the existing `lib/lobby/joinCode`
  validators.
- **Display_Name:** A participant's shown name, valid when it contains 1 to 40 characters after
  trimming leading and trailing whitespace, per the existing `validateDisplayName` validator.
- **Share_Link:** A URL of the form `/games/{gameId}/lobby?code={Join_Code}` that carries a Game's
  identifier and Join_Code so a recipient who opens it lands in the Game's Lobby with the Join_Code
  prefilled, per the app-shell-navigation model.
- **Create_Game_Surface:** The presentational create-game component (`CreateGame.tsx`) where an
  Admin designates the Start_Bar and Finish_Bar and, after this feature, enters a Display_Name.
- **Join_Game_Form:** The presentational code-entry component (`JoinGame.tsx`) where a visitor
  enters a Join_Code and Display_Name to join a Game.
- **Team_Pipeline:** The team-selection and team-creation surface (`TeamSelection.tsx`) shown to a
  participant who already has a Player row for the Game.
- **Lobby_Client:** The lobby page (`app/games/[gameId]/lobby/page.tsx`) that composes the lobby
  components, owns Session identity and per-game local facts, sends the `x-bbb-session-id` header
  on requests, and orchestrates the create-then-join flow.
- **Join_Service:** The existing server join route (`/api/games/{gameId}/join`) that records a
  Player, with idempotent `(game_id, session_id)` semantics returning the existing Player when the
  Session has already joined.
- **Player_Fact:** The durable per-game local record `bbb:player:{gameId}` written by the
  Lobby_Client that stores the Session's Player identifier for the Game and drives whether the
  Lobby_Client shows the Team_Pipeline.

## Requirements

### Requirement 1: Required Display Name on the Create-Game Surface

**User Story:** As a host, I want to enter my display name when I create a game, so that I join as a player and can pick a team.

#### Acceptance Criteria

1. THE Create_Game_Surface SHALL present a Display_Name input field in addition to the existing Start_Bar and Finish_Bar fields.
2. WHEN an Admin submits the Create_Game_Surface with a Display_Name that contains 1 to 40 characters after trimming leading and trailing whitespace, THE Create_Game_Surface SHALL treat the Display_Name as valid.
3. IF an Admin submits the Create_Game_Surface with a Display_Name that, after trimming leading and trailing whitespace, contains fewer than 1 or more than 40 characters, THEN THE Create_Game_Surface SHALL block submission, issue no create request, and display an inline validation message identifying the Display_Name as invalid.
4. WHILE the Start_Bar, Finish_Bar, or Display_Name field fails its client-side validation, THE Create_Game_Surface SHALL keep the create control from issuing a create request.
5. WHEN the Create_Game_Surface reports a valid submission, THE Create_Game_Surface SHALL provide the trimmed Display_Name together with the Start_Bar and Finish_Bar names to the Lobby_Client.

### Requirement 2: Host Joins as a Player After Create

**User Story:** As a host, I want to be joined into my own game automatically after creating it, so that I land in team selection without re-entering anything.

#### Acceptance Criteria

1. WHEN the create-game request succeeds and returns a Game identifier and a Join_Code, THE Lobby_Client SHALL send a join request to the Join_Service for that Game identifier carrying the returned Join_Code and the Admin's trimmed Display_Name.
2. WHEN the Lobby_Client sends the host join request, THE Lobby_Client SHALL present the same Session identifier used for the create request via the `x-bbb-session-id` header.
3. WHEN the host join request succeeds and returns a Player identifier, THE Lobby_Client SHALL write the Player identifier to the Player_Fact for that Game and set the Session's current Player identifier so the Lobby_Client shows the Team_Pipeline.
4. WHERE the Admin's Session has already joined the same Game, THE Join_Service SHALL return the existing Player record rather than creating a second Player, and THE Lobby_Client SHALL use the returned Player identifier.
5. THE Lobby_Client SHALL rely on the existing Join_Service without introducing a new or modified server route to join the host.

### Requirement 3: Recovery When Create Succeeds but Host Join Fails

**User Story:** As a host whose join step failed right after creating, I want to recover without recreating the game, so that I do not end up with a duplicate or orphaned game.

#### Acceptance Criteria

1. IF the create-game request succeeds but the subsequent host join request fails, THEN THE Lobby_Client SHALL keep the created Game and SHALL NOT issue a second create request.
2. WHILE the Admin's Session has created a Game but has no Player_Fact for that Game, THE Lobby_Client SHALL treat the Admin as a not-yet-joined Admin and present a path to complete joining that Game.
3. WHEN a not-yet-joined Admin completes the join for a Game the Admin's Session created, THE Lobby_Client SHALL record the resulting Player identifier in the Player_Fact and show the Team_Pipeline.
4. WHERE the host join request is retried for a Game the Admin's Session already joined, THE Join_Service SHALL return the existing Player record so the retry produces no duplicate Player.

### Requirement 4: Code-Entry Form Only for Visitors Without a Player Row

**User Story:** As a participant who has already joined, I want to see team selection instead of the code-entry form, so that I am not asked to join a game I am already in.

#### Acceptance Criteria

1. WHILE a Game is in the Lobby and the requesting Session has no Player_Fact for that Game, THE Lobby_Client SHALL render the Join_Game_Form.
2. WHILE a Game is in the Lobby and the requesting Session has a Player_Fact for that Game, THE Lobby_Client SHALL render the Team_Pipeline and SHALL NOT render the Join_Game_Form.
3. WHEN an Admin has completed the host join for a Game the Admin's Session created, THE Lobby_Client SHALL render the Team_Pipeline rather than the Join_Game_Form.
4. WHILE a Game is in the Lobby, THE Lobby_Client SHALL render exactly one of the Join_Game_Form or the Team_Pipeline for the requesting Session.

### Requirement 5: Display the Join Code and a Shareable Link with Copy Affordances

**User Story:** As a host, I want to see the join code and a shareable link with copy buttons, so that I can quickly invite players.

#### Acceptance Criteria

1. WHILE a Game in the Lobby has a known Join_Code, THE Lobby_Client SHALL display the Join_Code as visible text.
2. WHILE a Game in the Lobby has a known Join_Code, THE Lobby_Client SHALL display a Share_Link constructed as the Lobby URL for the Game with the Join_Code embedded as the `code` query parameter, so a recipient who opens the Share_Link lands with the Join_Code prefilled.
3. THE Lobby_Client SHALL construct the Share_Link origin from the browser's current origin at render time on the client.
4. WHEN the Lobby_Client renders on the server where the browser origin is unavailable, THE Lobby_Client SHALL render the Join_Code and SHALL omit the absolute Share_Link rather than fail to render.
5. WHEN a user activates the copy control for the Join_Code, THE Lobby_Client SHALL copy the raw Join_Code to the clipboard.
6. WHEN a user activates the copy control for the Share_Link, THE Lobby_Client SHALL copy the Share_Link to the clipboard.
7. WHEN a user activates either copy control, THE Lobby_Client SHALL keep the Join_Code visible as text.

### Requirement 6: Reuse of Existing Validators and Session Identity

**User Story:** As a developer, I want the client to reuse the existing validators and session header, so that client feedback matches server enforcement and no divergence is introduced.

#### Acceptance Criteria

1. THE Create_Game_Surface SHALL validate the Display_Name using the existing `validateDisplayName` validator so that the accepted range matches the Join_Service's enforced range.
2. THE Lobby_Client SHALL normalize and validate any submitted Join_Code using the existing `lib/lobby/joinCode` helpers before issuing a join request.
3. WHEN the Lobby_Client issues any create or join request, THE Lobby_Client SHALL present the Session identifier via the `x-bbb-session-id` header.
4. THE Lobby_Client SHALL introduce no new server route and no change to an existing server route to satisfy this feature.
