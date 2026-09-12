# Requirements Document

## Introduction

This feature delivers **Game Setup & Lobby** (ROADMAP section 1: F1.1, F1.2, F1.3) for the
Beltline Bar Brawl web app. It is the first end-to-end player-facing feature built on the
web-app-foundation backbone (schema, append-only `game_events` log, session-based identity,
RLS, and the Supabase Realtime subscription client).

The feature covers three cohesive slices of one lobby lifecycle:

- **F1.1 — Create/host a game (admin):** an admin creates a game, designates the start bar
  and finish bar, and receives a join code/link that players use to join.
- **F1.2 — Join a game & team selection (players):** a player opens the join code/link,
  provides a display name, and either joins an existing team or (while fewer than 4 teams
  exist) creates a new colored team.
- **F1.3 — Start the game (admin):** the admin starts the game once 2–4 teams exist,
  transitioning the game from `lobby` to `live`, which unlocks claiming (handled by later
  features).

Every lobby state change (game created, bars designated, player joined, team created, team
membership changed, game started) is written as a domain change plus exactly one appended
`game_event` in a single server-side transaction, and propagates to all subscribed clients
in near real time via the existing Realtime subscription client. This directly serves the
v0 latency problem for the lobby. The UI is mobile-first, since players use phones while
walking the Beltline.

**Identity decision (cross-cutting):** this feature confirms the session-based identity model
established in the foundation (`games.admin_session_id`, `players.session_id`) rather than
account-based auth. An admin is the session that created the game; a player is a session that
joined it. No persistent cross-game identity records are introduced.

**Scope boundaries.** Bar *discovery* (map API vs. predetermined list, propose-a-bar) is
deferred to F2.1; this feature designates start/finish bars by name/location only. Claiming,
scoring, cards, and game-end behavior are out of scope and owned by later features. This
feature's `live` transition only *unlocks* claiming; it does not implement it. Recovery or transfer
of Admin authority when an Admin's Session is permanently lost (for example, a lost or wiped device)
is out of scope and deferred to admin controls (F4.2); a live Game with an unreachable Admin still
ends via the foundation's auto-timeout.

## Glossary

- **Game:** A single BBB match, represented by a row in the `games` table, with a
  `lifecycle` of `lobby`, `live`, or `ended`.
- **Lobby:** The `lifecycle = 'lobby'` phase of a Game, during which teams form and players
  join, before the Game goes `live`.
- **Admin:** The host session that created a Game, identified by `games.admin_session_id`.
  There is exactly one Admin per Game.
- **Player:** A participant session that has joined a Game, represented by a row in the
  `players` table and identified by `players.session_id` within that Game.
- **Session:** The per-game, session-based identity of an Admin or Player (a session
  identifier), consistent with the foundation Identity_Model. No account is required.
- **Team:** A named, colored group within a Game, represented by a row in the `teams` table.
  A Game has 2 to 4 Teams when it starts.
- **Start_Bar:** The bar a Game begins at, worth 0 points, designated on the Game via
  `games.start_bar_id`.
- **Finish_Bar:** The bar whose claim ends a Game, designated on the Game via
  `games.finish_bar_id`. Distinct from the Start_Bar.
- **Join_Code:** A unique, shareable code recorded on `games.join_code` that a Player uses to
  locate and join a Game. A join link is a URL that carries the Join_Code.
- **Lobby_Service:** The server-side component that validates and applies lobby state changes
  (create game, designate bars, join, create/switch team, start game), each as a domain write
  plus one appended `game_event` in a single transaction.
- **Game_Event:** A row in the append-only `game_events` log recording one state change,
  serving as both history and the real-time propagation source (from the foundation).
- **Lobby_Client:** The mobile-first browser UI that renders lobby state, subscribes to a
  Game's Real_Time_Channel, and applies incoming Game_Events in order.
- **Real_Time_Channel:** The per-Game Supabase Realtime stream of `game_events` rows the
  Lobby_Client subscribes to (from the foundation).

## Requirements

### Requirement 1: Create a Game (F1.1)

**User Story:** As an admin, I want to create a game, so that I can host a Beltline Bar Brawl match for my group.

#### Acceptance Criteria

1. WHEN an Admin submits a request to create a Game, THE Lobby_Service SHALL create a Game with `lifecycle` set to `lobby`.
2. WHEN the Lobby_Service creates a Game, THE Lobby_Service SHALL record the creating Session as the Game's `admin_session_id`.
3. IF a request to create a Game carries no valid Session, THEN THE Lobby_Service SHALL reject the request and create no Game and no Game_Event.
4. WHEN the Lobby_Service creates a Game, THE Lobby_Service SHALL generate a Join_Code of 6 to 8 alphanumeric characters that is unique across all Games whose `lifecycle` is not `ended`.
5. IF generating a unique Join_Code does not succeed within 5 attempts, THEN THE Lobby_Service SHALL reject the create request and create no Game and no Game_Event.
6. WHEN the Lobby_Service creates a Game, THE Lobby_Service SHALL append exactly one Game_Event recording the creation, within the same transaction as the Game write.
7. IF the transaction that creates a Game fails, THEN THE Lobby_Service SHALL roll back so that no Game and no Game_Event persist.
8. WHEN the create-Game transaction commits, THE Lobby_Service SHALL return the Game identifier and the Join_Code to the Admin.

### Requirement 2: Designate Start and Finish Bars (F1.1)

**User Story:** As an admin, I want to set the start bar and finish bar, so that the game has a defined route from beginning to end.

#### Acceptance Criteria

1. WHEN an Admin designates a Start_Bar for a Game, THE Lobby_Service SHALL record the Start_Bar on the Game.
2. WHEN an Admin designates a Finish_Bar for a Game, THE Lobby_Service SHALL record the Finish_Bar on the Game.
3. IF an Admin designates a Finish_Bar equal to the Start_Bar of the same Game, THEN THE Lobby_Service SHALL reject the designation, leave the existing designation unchanged, and return a result indicating the start and finish bars must differ.
4. IF an Admin designates a Bar that does not exist, THEN THE Lobby_Service SHALL reject the designation, leave the existing designation unchanged, and return a result indicating the bar was not found.
5. WHILE a Game is in the Lobby, THE Lobby_Service SHALL allow the Admin to change the Start_Bar and Finish_Bar designations.
6. IF an Admin attempts to designate a Start_Bar or Finish_Bar for a Game whose `lifecycle` is not `lobby`, THEN THE Lobby_Service SHALL reject the designation, leave the existing designation unchanged, and return a lobby-closed result.
7. WHEN the Lobby_Service records a Start_Bar or Finish_Bar designation, THE Lobby_Service SHALL append exactly one Game_Event recording the designation, within the same transaction as the designation write.
8. IF a Session other than the Game's Admin attempts to designate a Start_Bar or Finish_Bar, THEN THE Lobby_Service SHALL reject the request, leave the existing designation unchanged, and return a result indicating the requester is not the Admin.

### Requirement 3: Join a Game (F1.2)

**User Story:** As a player, I want to join a game using a code or link, so that I can participate in a match my host set up.

#### Acceptance Criteria

1. WHEN a Player submits a Join_Code that consists of 6 to 12 alphanumeric characters and matches exactly one existing Game, THE Lobby_Service SHALL allow the Player to proceed to team selection for that Game.
2. IF a Player submits a Join_Code that matches no Game, THEN THE Lobby_Service SHALL reject the join request and return a not-found result while creating no Player record.
3. IF a Player submits a Join_Code whose format is not 6 to 12 alphanumeric characters, THEN THE Lobby_Service SHALL reject the join request and return an invalid-code result while creating no Player record.
4. IF a Player submits a request to join a Game whose `lifecycle` is not `lobby`, THEN THE Lobby_Service SHALL reject the join request and return a lobby-closed result while creating no Player record.
5. WHEN a Player joins a Game, THE Lobby_Service SHALL require a display name that, after trimming leading and trailing whitespace, contains 1 to 40 characters.
6. IF a Player submits a join request whose display name, after trimming leading and trailing whitespace, contains fewer than 1 or more than 40 characters, THEN THE Lobby_Service SHALL reject the join request and return an invalid-display-name result while creating no Player record.
7. WHEN a Player joins a Game with a valid display name, THE Lobby_Service SHALL record the Player with the joining Session and the trimmed display name.
8. IF a Session that is already a Player in a Game submits a join request for the same Game, THEN THE Lobby_Service SHALL return the existing Player record rather than creating a second Player for that Session.

### Requirement 4: Team Selection and Creation (F1.2)

**User Story:** As a player, I want to join an existing team or create a new one, so that I can play on a side with my friends.

#### Acceptance Criteria

1. WHEN a Player joins a Team in a Game, THE Lobby_Service SHALL associate the Player with the selected Team.
2. WHILE a Game has fewer than 4 Teams, THE Lobby_Service SHALL allow a Player to create a new Team in that Game.
3. IF a Player requests to create a new Team WHILE the Game already has 4 Teams, THEN THE Lobby_Service SHALL reject the team creation and return a team-limit-reached result.
4. WHEN a Player creates a Team, THE Lobby_Service SHALL require a non-empty Team name of at most 100 characters and assign the Team a color that is distinct from the colors of the other Teams in the same Game.
5. WHEN a Player changes from one Team to another Team within the same Game, THE Lobby_Service SHALL associate the Player with the newly selected Team and remove the association with the previous Team.
6. WHEN the Lobby_Service records a Player joining, a Team creation, or a Team change, THE Lobby_Service SHALL append exactly one Game_Event recording the change, within the same transaction as the domain write.
7. IF a Player submits a Team name that is empty or exceeds 100 characters, THEN THE Lobby_Service SHALL reject the team creation, leave existing Teams unchanged, and return a result indicating an invalid team name.
8. IF a Player requests to join, create, or change a Team in a Game whose `lifecycle` is not `lobby`, THEN THE Lobby_Service SHALL reject the request, leave the existing Team associations unchanged, and return a lobby-closed result.

### Requirement 5: Start the Game (F1.3)

**User Story:** As an admin, I want to start the game once teams are set, so that play begins and claiming is unlocked.

#### Acceptance Criteria

1. WHEN the Admin starts a Game that is in the Lobby and has between 2 and 4 Teams inclusive, THE Lobby_Service SHALL set the Game's `lifecycle` to `live`.
2. WHEN the Lobby_Service sets a Game's `lifecycle` to `live`, THE Lobby_Service SHALL record the UTC timestamp at which the Game went live on the Game.
3. IF the Admin attempts to start a Game that is in the Lobby and has fewer than 2 Teams, THEN THE Lobby_Service SHALL reject the start request, leave the Game in the Lobby, and return a start-rejected result indicating the minimum-team requirement was not met.
4. IF the Admin attempts to start a Game that is in the Lobby and has more than 4 Teams, THEN THE Lobby_Service SHALL reject the start request, leave the Game in the Lobby, and return a start-rejected result indicating the maximum-team limit was exceeded.
5. IF the Admin attempts to start a Game that is in the Lobby and does not have both a Start_Bar and a Finish_Bar designated, THEN THE Lobby_Service SHALL reject the start request, leave the Game in the Lobby, and return a start-rejected result indicating the required bar designations are missing.
6. IF a Session other than the Game's Admin attempts to start a Game, THEN THE Lobby_Service SHALL reject the start request, leave the Game's `lifecycle` unchanged, and return a start-rejected result indicating the requester is not the Admin.
7. IF the Admin attempts to start a Game whose `lifecycle` is not `lobby`, THEN THE Lobby_Service SHALL reject the start request, leave the Game's `lifecycle` unchanged, and return a start-rejected result indicating the Game is not in the Lobby.
8. WHEN the Lobby_Service sets a Game's `lifecycle` to `live`, THE Lobby_Service SHALL append exactly one Game_Event recording the start, within the same transaction as the lifecycle write.

### Requirement 6: Atomic Lobby State Changes

**User Story:** As a developer, I want every lobby state change written atomically with its event, so that the persisted state and the event log never diverge.

#### Acceptance Criteria

1. WHEN the Lobby_Service applies a lobby state change, THE Lobby_Service SHALL write the domain change and append exactly one Game_Event within a single database transaction.
2. IF appending the Game_Event for a lobby state change fails, THEN THE Lobby_Service SHALL roll back the transaction so that neither the domain change nor the Game_Event persists.
3. IF the domain write for a lobby state change fails, THEN THE Lobby_Service SHALL roll back the transaction so that neither the domain change nor the Game_Event persists.
4. WHEN a lobby state change is applied successfully, THE Lobby_Service SHALL return a structured result that reports success and includes the appended Game_Event's identifier and its per-game sequence number.
5. IF a lobby state change is not applied, THEN THE Lobby_Service SHALL return a structured result that reports failure and includes an indication of the reason the change was not applied, with no partial domain change and no Game_Event persisted.
6. WHILE two or more lobby state changes for the same game are applied concurrently, THE Lobby_Service SHALL serialize their Game_Event appends so that each committed event receives a distinct, contiguous per-game sequence number and the persisted state matches the event log.

### Requirement 7: Real-Time Lobby Propagation

**User Story:** As a player or admin, I want the lobby to update in near real time, so that I see players joining, team changes, and the game starting without refreshing.

#### Acceptance Criteria

1. WHEN a Game_Event for a lobby state change is committed, THE Real_Time_Channel SHALL deliver that Game_Event to every Lobby_Client currently subscribed to the Game within 5 seconds of the commit.
2. WHEN a Lobby_Client subscribes to a Game, THE Lobby_Client SHALL load a snapshot computed by applying, in ascending sequence order, every Game_Event persisted for that Game before the subscription.
3. WHEN a Lobby_Client receives lobby Game_Events, THE Lobby_Client SHALL apply them in ascending sequence order and ignore any Game_Event whose sequence is at or below its highest contiguously-applied sequence.
4. THE Real_Time_Channel SHALL deliver to a Lobby_Client only Game_Events belonging to the Game the Lobby_Client subscribed to.
5. IF a subscribed Lobby_Client loses its Real_Time_Channel connection while active, THEN THE Lobby_Client SHALL retry reconnection at intervals not exceeding 5 seconds for at most 12 attempts, and upon the 12th failed attempt SHALL enter a terminal state that indicates to the user that a reload is required.
6. WHEN a Lobby_Client resumes from background or relaunch, THE Lobby_Client SHALL apply every Game_Event with a sequence greater than its last persisted applied sequence, in ascending sequence order, before resuming live delivery.

### Requirement 8: Session-Based Identity and Access

**User Story:** As a player or admin, I want to be identified by a lightweight session, so that I can host or join without creating an account.

#### Acceptance Criteria

1. WHEN a Session creates a Game, THE Lobby_Service SHALL record that Session as the Game's Admin and permit it to perform admin-only actions on that Game.
2. WHEN a Session that is not already a Player joins a Game, THE Lobby_Service SHALL create exactly one Player record identifying that Player by the Session within the Game.
3. IF a request to read or modify a Game's lobby state carries no valid Session, THEN THE Lobby_Service SHALL reject the request and leave the Game's lobby state unchanged.
4. WHEN a request modifies lobby state, THE Lobby_Service SHALL confirm the requesting Session is a member of the target Game before applying the change.
5. IF a Session that is not a member of a Game requests to read or modify that Game's lobby state, THEN THE Lobby_Service SHALL reject the request, leave the Game's lobby state unchanged, and return a result indicating the requester is not authorized.
6. WHEN a Session is established for an Admin or Player, THE Lobby_Client SHALL persist the Session identifier in durable client storage that survives the app being closed and reopened on the same device and browser.
7. WHEN the Lobby_Client reopens on the same device and browser and a persisted Session identifier is present, THE Lobby_Client SHALL present that persisted Session identifier on subsequent requests rather than establishing a new Session.
8. WHEN a request presents a Session identifier that equals a Game's `admin_session_id`, THE Lobby_Service SHALL re-recognize that Session as the Game's Admin and restore its admin-only capabilities.
9. IF the persisted Session identifier is absent or cannot be read when the Lobby_Client reopens, THEN THE Lobby_Client SHALL establish a new Session, and THE Lobby_Service SHALL treat the request as a new, non-admin Session.

### Requirement 9: Mobile-First Lobby Interface

**User Story:** As a player walking the Beltline, I want the lobby to work well on my phone, so that I can join and manage my team on the go.

#### Acceptance Criteria

1. WHILE rendered on a viewport between 360 and 430 pixels wide, THE Lobby_Client SHALL present the create-game, join-game, team-selection, and start-game interfaces in a single-column layout whose content fits within the viewport width without horizontal scrolling.
2. THE Lobby_Client SHALL render each interactive control with a minimum touch target of 44 by 44 pixels.
3. WHILE a Game is in the Lobby, THE Lobby_Client SHALL display the Game's Join_Code.
4. WHILE a Game is in the Lobby, THE Lobby_Client SHALL display the current Teams, each Team's color, and the Players on each Team.
5. WHEN a lobby Game_Event that changes Teams or Players is applied, THE Lobby_Client SHALL update the displayed Teams and Players within 5 seconds.
