# Requirements Document

## Introduction

This spec establishes the technical foundation for the Beltline Bar Brawl (BBB) web
application — phase 3 of the project. It covers three roadmap items from the
"0. Foundation & Decisions" section:

- **F0.1 — Stack & hosting decision:** lock the backend/hosting choice (Vercel + Supabase
  vs. an AWS alternative, with a rough cost estimate).
- **F0.2 — Project scaffold:** initialize the Node.js application, repo structure,
  linting/formatting, environment configuration, and a deployable "hello world."
- **F0.3 — Data model & real-time backbone:** the core persistent schema (games, teams,
  players, bars, claims, cards, card plays, events) and the real-time propagation
  mechanism that every live feature depends on.

The overriding technical concern is **real-time propagation**. In v0, cards played against
a team took up to 15 minutes to arrive by text, creating unfair timing in a game where time
is a primary resource. Every downstream feature (claims, scoring, card plays, targeting
notifications, and the photo feed) relies on near-real-time delivery of state changes to all
connected clients. This foundation must prove that capability and establish the schema those
features build on.

This spec produces decisions, scaffolding, a data schema, and a working real-time
propagation demonstration. It does **not** implement game features (lobby, claiming, cards,
endgame); those are later roadmap items that build on this foundation. The data model,
however, is designed to accommodate the full v1 game so later features extend the schema
rather than redesign it.

Cross-cutting concerns folded into this spec: real-time propagation (primary), mobile-first
delivery, an auth/identity decision, and the photo lifecycle/privacy decision.

## Glossary

- **BBB_Application**: The Beltline Bar Brawl web application being built, comprising a
  Node.js frontend/backend and its managed backend services.
- **Foundation_Spec**: The scope of this document (F0.1, F0.2, F0.3).
- **Backend_Platform**: The chosen managed backend providing database, authentication,
  real-time messaging, and file storage (candidate: Supabase; alternative: AWS).
- **Hosting_Decision_Record**: A written decision document comparing the Vercel + Supabase
  option against the AWS alternative, including a rough cost estimate, and recording the
  locked choice.
- **Real_Time_Channel**: The mechanism that delivers persisted state changes to all
  subscribed clients in near real time (candidate: Supabase real-time subscriptions).
- **Game_State_Change**: Any persisted mutation that live clients must observe, including
  bar claims, score updates, card plays, targeting notifications, and feed events.
- **Data_Schema**: The persistent database schema and its migrations, covering games, teams,
  players, bars, claims, card definitions, card instances, card plays, and game events.
- **Game_Event**: An append-only record in the events log describing a single occurrence in
  a game, used as the backbone for real-time propagation and history.
- **Card_Definition**: A catalog entry describing a v1 card's identity and static
  attributes (name, type, targeting, effect summary), independent of any single game.
- **Card_Instance**: A specific card held or discarded within a specific game, referencing a
  Card_Definition.
- **Identity_Model**: The chosen approach for identifying an admin and players (account-based
  vs. lightweight per-game session), as decided in this spec.
- **Photo_Lifecycle_Policy**: The chosen approach for temporary photo storage, retention
  duration, and takedown of feed photos, as decided in this spec.
- **Environment_Configuration**: The mechanism for supplying secrets and per-environment
  settings (local, preview, production) to the BBB_Application without committing secrets.
- **Deployable_Baseline**: A minimal running deployment of the BBB_Application ("hello
  world") reachable at a public URL on the chosen hosting target.
- **Admin**: The host who sets up and runs a game.
- **Player**: A participant who joins a game as a member of a team.
- **Latency_Budget**: The maximum acceptable time between a Game_State_Change being persisted
  and all connected clients observing it. Set to 3 seconds for this project.
- **Client**: An instance of the BBB_Application running in a player's or Admin's browser,
  subscribed to a game over the Real_Time_Channel.
- **Last_Seen_Sequence**: The per-game Game_Event sequence value of the most recent
  Game_Event a Client has received, used to fetch missed Game_Events on resume or reconnect.

## Requirements

### Requirement 1: Stack and Hosting Decision (F0.1)

**User Story:** As the project owner, I want the backend and hosting stack locked with a
documented rationale and rough cost estimate, so that build work can proceed on a stable,
agreed foundation.

#### Acceptance Criteria

1. THE Foundation_Spec SHALL produce a Hosting_Decision_Record that compares the
   Vercel + Supabase option against an AWS-based alternative.
2. THE Hosting_Decision_Record SHALL record, for each option, a per-capability verdict of
   pass or fail against each of real-time propagation capability, managed Postgres,
   authentication, file/photo storage, and mobile-first web delivery.
3. WHEN evaluating real-time propagation capability, THE Hosting_Decision_Record SHALL
   record for each option whether the option can deliver a persisted Game_State_Change to
   subscribed clients within the Latency_Budget of 3 seconds, as a pass or fail verdict.
4. THE Hosting_Decision_Record SHALL include a rough cost estimate for each option expressed
   as a single monthly figure in United States dollars, sized for a single concurrent game
   of up to 4 teams of 4 players plus 1 Admin.
5. THE Hosting_Decision_Record SHALL record one locked choice of Backend_Platform and
   hosting target with a written rationale.
6. WHERE the locked choice differs from the Supabase candidate named in the project's
   technical direction, THE Hosting_Decision_Record SHALL document the reason for the
   deviation.
7. THE Hosting_Decision_Record SHALL record the resolution of the Identity_Model decision
   (account-based vs. lightweight per-game session) with a rationale.
8. THE Hosting_Decision_Record SHALL record the resolution of the Photo_Lifecycle_Policy
   decision, including storage location, retention duration, and takedown approach.
9. IF the AWS-alternative comparison data cannot be fully produced within this spec, THEN
   THE Hosting_Decision_Record SHALL mark the missing portion as deferred and name the later
   roadmap item that will resolve it.
10. WHERE an open decision from the project's technical direction cannot be resolved within
    this spec, THE Hosting_Decision_Record SHALL list the decision as deferred and name the
    later roadmap item that will resolve it.

### Requirement 2: Project Scaffold (F0.2)

**User Story:** As a developer, I want an initialized Node.js project with a defined
structure, linting, formatting, and environment configuration, so that I can build features
consistently and deploy reliably.

#### Acceptance Criteria

1. THE BBB_Application SHALL be initialized as a Node.js project targeting the locked
   hosting target from Requirement 1.
2. THE BBB_Application SHALL define a repository directory structure containing separate
   locations for application code, shared game logic, backend/database configuration, and
   static assets.
3. WHEN the project structure is established, THE Foundation_Spec SHALL update the project's
   structure documentation so that every directory named in the documentation matches an
   existing directory in the repository and every top-level source directory in the
   repository is listed in the documentation.
4. THE BBB_Application SHALL include a linter configuration and a code-formatter
   configuration, each invocable through a defined project command.
5. WHEN a developer runs the configured lint command on the scaffolded codebase, THE
   BBB_Application SHALL report zero lint errors.
6. WHEN a developer runs the configured format-check command on the scaffolded codebase, THE
   BBB_Application SHALL report zero formatting violations.
7. THE BBB_Application SHALL provide Environment_Configuration that supplies per-environment
   settings for the local, preview, and production environments without committing secret
   values to the repository.
8. THE Environment_Configuration SHALL include a committed example file that lists every
   required environment variable by name with placeholder (non-secret) values.
9. IF one or more required environment variables are missing or empty at application startup,
   THEN THE BBB_Application SHALL halt startup before serving any request and report the name
   of each missing variable, leaving the application in a not-started state.
10. THE BBB_Application SHALL provide a Deployable_Baseline that, when requested at its public
    URL on the locked hosting target, returns a rendered response indicating the baseline is
    running and reports no server error.
11. WHILE displayed on a mobile viewport between 320 and 375 CSS pixels wide, THE
    Deployable_Baseline SHALL present all content within the viewport width with no
    horizontal scrolling and no content clipped beyond the viewport edges.

### Requirement 3: Core Data Schema (F0.3)

**User Story:** As a developer, I want a persistent data schema that models the full v1 game,
so that later features read and write game state without redesigning the schema.

#### Acceptance Criteria

1. THE Data_Schema SHALL define entities for games, teams, players, bars, claims,
   Card_Definitions, Card_Instances, card plays, and Game_Events.
2. THE Data_Schema SHALL represent a game's lifecycle state including at least lobby, live,
   and ended.
3. THE Data_Schema SHALL record the timestamp, expressed in UTC, at which a game transitioned
   to the live state, so that the elapsed time since a game became live is computable.
4. THE Data_Schema SHALL record, for a game in the ended state, an end reason drawn from the
   enumeration of finish-bar-claimed, admin-ended, and auto-timeout.
5. THE Data_Schema SHALL associate each team with a game and each player with a team.
6. THE Data_Schema SHALL support 2 to 4 teams per game.
7. THE Data_Schema SHALL designate exactly one start bar and exactly one finish bar per game.
8. THE Data_Schema SHALL record a claim as an association between one team and one bar within
   one game, with a claim timestamp.
9. THE Data_Schema SHALL prevent a team from recording more than one claim on the same bar
   within the same game.
10. THE Data_Schema SHALL store each Card_Definition from the finalized v1 card catalog, such
    that every finalized v1 card is represented, with a name, a card type drawn from the
    enumeration of opponent-slowing, economy/boost, and reactive, and a flag indicating
    whether the card requires a target.
11. THE Data_Schema SHALL represent a Card_Instance as belonging to a specific game and
    carrying a lifecycle state drawn from the enumeration of in-hand, played, and discarded,
    such that a team's current hand, played cards, and discarded cards are each representable.
12. THE Data_Schema SHALL record a card play with the casting team, the played Card_Instance,
    an optional target team, and a play timestamp.
13. THE Data_Schema SHALL store, per bar and per game, the set of teams currently claiming
    that bar and the designation of the finish bar, so that each non-finish bar's 12-point
    split among its current claimers and the finish bar's solo 12-point award to the single
    claiming team are computable.
14. THE Data_Schema SHALL be created and modified through committed migration files that run
    against the Backend_Platform.
15. WHERE the Identity_Model resolved in Requirement 1 is account-based, THE Data_Schema
    SHALL associate players and the Admin with persistent identity records.

### Requirement 4: Game Events Log

**User Story:** As a developer, I want an append-only log of game events, so that real-time
propagation and game history share one authoritative source of state changes.

#### Acceptance Criteria

1. THE Data_Schema SHALL provide a Game_Event record associated with exactly one game, where
   the record is immutable after creation and supports insert-only access with no update or
   delete operations.
2. THE Game_Event SHALL record an event type, the acting team identifier or the value "admin"
   when the actor is the Admin or "system" when there is no acting team or Admin, an event
   payload no larger than 16 kilobytes, and a creation timestamp expressed in UTC with
   millisecond precision.
3. WHEN a Game_State_Change is persisted, THE BBB_Application SHALL write exactly one
   corresponding Game_Event within the same atomic operation so that the Game_State_Change
   and its Game_Event either both succeed or both fail.
4. IF writing the Game_Event fails, THEN THE BBB_Application SHALL roll back the associated
   Game_State_Change, leave the Game_Event log unchanged, and return an error response
   indicating the state change was not applied.
5. THE BBB_Application SHALL assign each Game_Event a per-game sequence value that strictly
   increases with no gaps or duplicates, such that ordering Game_Events by that value
   reproduces the exact order in which they were written.
6. WHILE a game has not ended, THE BBB_Application SHALL retain all Game_Events for that game
   without deletion or modification.

### Requirement 5: Game End Conditions

**User Story:** As an Admin, I want a live game to end when I choose to end it or after a
fixed maximum duration, so that a game cannot remain live indefinitely when play stops.

#### Acceptance Criteria

1. WHEN the Admin ends a live game, THE BBB_Application SHALL transition the game to the
   ended state and record the end reason as admin-ended.
2. IF 12 hours elapse after a game transitioned to the live state without the game having
   ended, THEN THE BBB_Application SHALL transition the game to the ended state and record
   the end reason as auto-timeout.
3. WHEN the BBB_Application transitions a game to the ended state, THE BBB_Application SHALL
   treat the transition as a Game_State_Change and write the corresponding Game_Event within
   the same atomic operation defined in Requirement 4.
4. IF the Admin attempts to end a game that is not in the live state, THEN THE
   BBB_Application SHALL reject the request and leave the game's lifecycle state unchanged.
5. WHILE a game is in the ended state, THE BBB_Application SHALL reject any further request
   to transition the game to the ended state and leave the recorded end reason unchanged.

### Requirement 6: Real-Time Propagation Backbone

**User Story:** As a player, I want game state changes to reach my device within a few
seconds, so that card plays and claims are timely and fair, fixing the v0 latency problem.

#### Acceptance Criteria

1. THE BBB_Application SHALL provide a Real_Time_Channel that delivers Game_State_Changes to
   all clients subscribed to a game.
2. WHEN a Game_Event is persisted for a game, THE Real_Time_Channel SHALL deliver the
   corresponding Game_State_Change to every subscribed client for that game within the
   Latency_Budget of 3 seconds, measured from the time the Game_Event is committed to
   persistent storage to the time the client receives it.
3. WHILE a client is subscribed to a game, THE Real_Time_Channel SHALL deliver Game_Events
   for that game only, excluding events from other games.
4. WHEN a client subscribes to a game, THE BBB_Application SHALL deliver a snapshot of the
   current game state within the Latency_Budget of 3 seconds, such that the snapshot reflects
   all Game_Events persisted for that game before the subscription was established.
5. WHILE the application is actively open and the Real_Time_Channel connection is lost, THE
   Client SHALL attempt to reconnect at intervals not exceeding 5 seconds for a maximum of 12
   attempts.
6. WHILE a client is subscribed to a game, THE Client SHALL record the sequence value of the
   most recent Game_Event it has received as its Last_Seen_Sequence for that game.
7. WHEN the application is resumed from the background or relaunched after being closed, THE
   Client SHALL re-initialize its connection to the game by fetching all Game_Events for that
   game whose sequence value is greater than its Last_Seen_Sequence, resubscribing to the
   Real_Time_Channel, and applying a current game state snapshot as defined in criterion 4,
   independent of any prior reconnection-attempt budget from criterion 5.
8. WHEN the Client re-initializes on resume or relaunch, THE Client SHALL enter a
   reconnecting or resynchronizing state rather than a terminal state that requires a manual
   reload.
9. WHEN a client receives multiple Game_State_Changes for a game, THE Real_Time_Channel SHALL
   deliver them in the order their Game_Events were persisted.
10. THE Foundation_Spec SHALL demonstrate end-to-end real-time propagation by showing a
    persisted Game_State_Change appearing on a separate subscribed client within the
    Latency_Budget of 3 seconds.

### Requirement 7: Secrets and Access Safety

**User Story:** As the project owner, I want secrets and backend access handled safely from
the start, so that credentials are never leaked and client access is scoped.

#### Acceptance Criteria

1. THE BBB_Application SHALL exclude secret-bearing files, including .env files and
   environment secret files, from version control.
2. IF a client authorized for one game requests to read or modify another game's data, THEN
   THE BBB_Application SHALL deny the request and leave the other game's data unchanged.
3. WHERE the Backend_Platform exposes credentials to the browser client, THE BBB_Application
   SHALL place only public or anonymous client keys in the browser and SHALL keep privileged
   or service keys server-side only.
4. THE BBB_Application repository SHALL contain no committed secret values, verifiable by a
   secret-scanning check that reports no findings.
