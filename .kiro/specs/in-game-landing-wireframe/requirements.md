# Requirements Document

## Introduction

This feature delivers the **in-game landing wireframe** for the Beltline Bar Brawl web app:
the connective in-game shell that every player and the admin land on once a Game transitions
from `lobby` to `live`. It is the UI/UX skeleton that later UI-wiring specs (U2.1 bars,
claiming & scoreboard; U3.1 cards & photo feed; U4.1 endgame & admin) plug their real
behavior into.

This is deliberately a **wireframe / UI skeleton** feature. It establishes the layout,
the navigation regions, and placeholder surfaces for capabilities that are not yet built. It
does **not** implement claiming, scoring, card draw/validation, targeting enforcement, photo
handling, or game-end logic — those are owned by later roadmap features (F2.x, F3.x, F4.x).
Where this feature depicts a future behavior (for example, playing a card, or being targeted
by a card), it renders a **wireframe interaction** — a placeholder flow that anticipates the
shape of the real feature — not the enforced game rule.

The feature covers five cohesive slices, all inside one mobile-first in-game shell:

- **In-game shell & region navigation:** the page a `live` Game lands on, with navigable
  regions for bars, the scoreboard, and the player's cards.
- **Bars region (wireframe):** a placeholder surface for claiming and viewing bars.
- **Scoreboard region (wireframe):** a placeholder surface for viewing other Teams' scores
  and the bars each Team has claimed.
- **Cards region (wireframe):** a placeholder surface for viewing the player's own hand.
- **Card interaction wireframes:** the play-a-card flow and the card-played-on-you
  (immediate targeted notification) flow, the latter propagating in near real time via the
  existing `game_events` backbone.

**Reuse & identity.** This feature reuses the foundation's session-based identity model
(`x-bbb-session-id`, one Session per device), the append-only `game_events` log, and the
existing Supabase Realtime subscription client (`lib/realtime`), consistent with how the
lobby page subscribes and folds events. The stack is locked: Next.js App Router +
TypeScript, Vercel + Supabase, Vitest + fast-check, mobile-first.

**Scope boundaries.** No claim, scoring, card-draw, card-validation, targeting-enforcement,
photo, or game-end logic is implemented; the regions render placeholder/wireframe content
only. The card-played-on-you flow demonstrates *immediate notification* wiring on the
realtime backbone but does **not** enforce the "blocked from claiming until conditions are
met" rule (owned by F3.2). The `lobby → live` transition itself is owned by
`game-setup-lobby` (F1.3, done); this feature only consumes the resulting `live` state and
`game_started` event. The lobby experience and its polish (U1.1) remain out of scope.

## Glossary

- **Game:** A single BBB match, a row in the `games` table with a `lifecycle` of `lobby`,
  `live`, or `ended`.
- **Live_Game:** A Game whose `lifecycle` is `live`, reached when the Admin starts the Game.
- **Admin:** The host Session that created a Game, identified by `games.admin_session_id`.
- **Player:** A participant Session that joined a Game and is associated with a Team,
  represented by a row in the `players` table.
- **Session:** The per-device, session-based identity of an Admin or Player, carried in the
  `x-bbb-session-id` header, consistent with the foundation Identity_Model. No account is
  required.
- **Team:** A named, colored group within a Game, represented by a row in the `teams` table.
  A Live_Game has 2 to 4 Teams.
- **Game_Board:** The mobile-first in-game page a Live_Game lands on, hosting the region
  navigation and the Bars_Region, Scoreboard_Region, and Cards_Region.
- **Region:** One of the three primary navigable areas of the Game_Board: the Bars_Region,
  the Scoreboard_Region, or the Cards_Region.
- **Bars_Region:** The Game_Board area that presents placeholder surfaces for claiming a bar
  and viewing bars. A wireframe for F2.x.
- **Scoreboard_Region:** The Game_Board area that presents placeholder surfaces for viewing
  each Team's score and the bars each Team has claimed. A wireframe for F2.2/F2.3.
- **Cards_Region:** The Game_Board area that presents a placeholder surface for viewing the
  current Player's own hand of cards. A wireframe for F3.1.
- **Card_Play_Wireframe:** The placeholder interaction for playing a card from the
  Cards_Region, including selecting a target Team when the card targets another Team.
- **Targeted_Notification:** The immediate, in-app notice a Player receives when another
  Team plays a targeting card on the Player's Team, delivered via the Real_Time_Channel.
- **Game_Event:** A row in the append-only `game_events` log recording one state change,
  serving as both history and the real-time propagation source (from the foundation).
- **Game_Board_Client:** The mobile-first browser UI that renders the Game_Board, subscribes
  to a Game's Real_Time_Channel, and applies incoming Game_Events in order.
- **Real_Time_Channel:** The per-Game Supabase Realtime stream of `game_events` rows the
  Game_Board_Client subscribes to (from the foundation).

## Requirements

### Requirement 1: Land on the Game Board when the Game is live

**User Story:** As a player or admin, I want to land on the in-game board once the game starts, so that I have a single in-game home for every play activity.

#### Acceptance Criteria

1. WHEN a Session that is the Admin or a Player of a Game opens the Game_Board WHILE that Game's `lifecycle` is `live`, THE Game_Board_Client SHALL render the Game_Board for that Game.
2. WHEN a Game_Board_Client applies a Game_Event that sets a Game's `lifecycle` to `live`, THE Game_Board_Client SHALL, within 5 seconds of applying that Game_Event, present a control that navigates from the lobby to the Game_Board for that Game.
3. IF a Session opens the Game_Board for a Game whose `lifecycle` is `lobby`, THEN THE Game_Board_Client SHALL direct the Session to that Game's lobby and SHALL NOT render the Bars_Region, Scoreboard_Region, or Cards_Region.
4. IF a Session opens the Game_Board for a Game whose `lifecycle` is `ended`, THEN THE Game_Board_Client SHALL present an ended-game indication and SHALL NOT render the Bars_Region, Scoreboard_Region, or Cards_Region.
5. IF a Session that is neither the Admin nor a Player of a Game opens the Game_Board for that Game, THEN THE Game_Board_Client SHALL present a not-authorized indication and SHALL NOT render the Bars_Region, Scoreboard_Region, or Cards_Region.
6. IF a request to open the Game_Board carries no valid Session, THEN THE Game_Board_Client SHALL direct the request to establish a Session and SHALL NOT render the Game_Board.

### Requirement 2: Region navigation

**User Story:** As a player, I want to move between the bars, scoreboard, and cards areas, so that I can reach each part of the game from one place.

#### Acceptance Criteria

1. THE Game_Board SHALL present navigation controls for exactly three Regions: the Bars_Region, the Scoreboard_Region, and the Cards_Region.
2. WHEN a Player activates the navigation control for a Region that is not the active Region, THE Game_Board_Client SHALL display that Region and make it the active Region.
3. WHEN the Game_Board first renders for a Live_Game, THE Game_Board_Client SHALL make the Bars_Region the initial active Region and display it.
4. THE Game_Board_Client SHALL visually distinguish the navigation control of the currently active Region from the navigation controls of the two non-active Regions.
5. WHILE a Region is active, THE Game_Board_Client SHALL keep the navigation controls for all three Regions displayed and operable so that the Player can switch to another Region without leaving the active Region.
6. THE Game_Board_Client SHALL display exactly one of the three Regions as active at any time.
7. WHEN a Player activates the navigation control for the Region that is already active, THE Game_Board_Client SHALL keep that Region active and SHALL NOT change which Region is displayed.

### Requirement 3: Bars region wireframe

**User Story:** As a player, I want a place to claim and view bars, so that the future claiming feature has a home in the interface.

#### Acceptance Criteria

1. WHEN the Bars_Region is active, THE Game_Board_Client SHALL display a placeholder surface for viewing bars.
2. WHEN the Bars_Region is active, THE Game_Board_Client SHALL display a placeholder claim control bearing a label that names claiming a bar as its intended action.
3. WHEN the Bars_Region is active, THE Game_Board_Client SHALL present a placeholder label indicating that bar selection, discovery, and claiming are provided by a later feature.
4. WHEN a Player activates the placeholder claim control, THE Game_Board_Client SHALL present a wireframe acknowledgement identifying the action as a placeholder.
5. IF the placeholder claim control is activated, THEN THE Game_Board_Client SHALL NOT record a claim, alter any Team's score, or append a Game_Event, and SHALL leave all Regions unchanged.
6. WHILE the current Session is the Admin and is not a Player of the Game, THE Bars_Region SHALL present an indication that claiming belongs to Players rather than presenting an operable placeholder claim control.

### Requirement 4: Scoreboard region wireframe

**User Story:** As a player, I want to see other teams' scores and the bars they claimed, so that I can gauge how my team compares.

#### Acceptance Criteria

1. WHEN the Scoreboard_Region is active, THE Game_Board_Client SHALL display one placeholder row for each Team in the Game, where the Game has between 2 and 4 Teams.
2. WHERE a Team has a color, THE Scoreboard_Region SHALL display that Team's color on that Team's placeholder row.
3. WHEN the Scoreboard_Region is active, THE Scoreboard_Region SHALL display a placeholder score value on each Team's placeholder row.
4. WHEN the Scoreboard_Region is active, THE Scoreboard_Region SHALL display a placeholder area for claimed bars on each Team's placeholder row.
5. WHEN the Scoreboard_Region is active, THE Scoreboard_Region SHALL present a placeholder label indicating that live scores and claimed bars are provided by a later feature.

### Requirement 5: Cards region wireframe

**User Story:** As a player, I want to view my own cards, so that I know what I can play.

#### Acceptance Criteria

1. WHEN the Cards_Region is active, THE Game_Board_Client SHALL display a placeholder surface representing the current Player's hand of cards.
2. WHEN the Cards_Region is active, THE Cards_Region SHALL display between 1 and 8 placeholder card elements, each presenting a play control.
3. WHEN the Cards_Region is active, THE Cards_Region SHALL present a placeholder label indicating that card draw and hand contents are provided by a later feature.
4. WHILE the current Session is the Admin and is not a Player of the Game, THE Cards_Region SHALL present an indication that a hand belongs to Players rather than displaying a Player hand.

### Requirement 6: Play-a-card interaction wireframe

**User Story:** As a player, I want to play a card and choose a target when needed, so that the future card-play feature's flow is represented.

#### Acceptance Criteria

1. WHEN a Player activates the play control on a placeholder card, THE Game_Board_Client SHALL present the Card_Play_Wireframe.
2. WHERE a placeholder card targets another Team, THE Card_Play_Wireframe SHALL present a target-selection control listing every other Team in the Game and excluding the current Player's own Team.
3. WHERE a placeholder card does not target another Team, THE Card_Play_Wireframe SHALL omit the target-selection control and present a confirm control directly.
4. WHEN a Player selects a target Team in the Card_Play_Wireframe, THE Game_Board_Client SHALL present a wireframe confirmation identifying the selected target Team.
5. IF a Player activates the confirm control for a placeholder card that targets another Team before a target Team has been selected, THEN THE Game_Board_Client SHALL present an indication that a target is required and SHALL NOT complete the card play.
6. WHEN a Player confirms a placeholder card play, THE Game_Board_Client SHALL present a wireframe acknowledgement and SHALL NOT enforce any card effect, alter any score, or block any Team from claiming.
7. WHEN a Player cancels the Card_Play_Wireframe before confirming, THE Game_Board_Client SHALL dismiss the Card_Play_Wireframe and leave the Cards_Region unchanged.

### Requirement 7: Card-played-on-you notification wireframe

**User Story:** As a player, I want to be notified immediately when a card is played on my team, so that the future targeting feature's real-time delivery is represented and validated.

#### Acceptance Criteria

1. WHEN a Player confirms a placeholder card play that targets another Team, THE Game_Board_Client SHALL append exactly one Game_Event recording the wireframe card play and its target Team.
2. WHEN a Game_Event recording a wireframe targeting card play is committed, THE Real_Time_Channel SHALL deliver that Game_Event to every subscribed Game_Board_Client of the target Team within 5 seconds of the commit.
3. WHEN a Game_Board_Client of a Player on the target Team receives a wireframe targeting Game_Event, THE Game_Board_Client SHALL present the Targeted_Notification identifying the casting Team within 1 second of receiving the Game_Event.
4. THE Targeted_Notification SHALL present a placeholder label indicating that the card's effect and any claiming restriction are provided by a later feature.
5. WHEN a Player dismisses the Targeted_Notification, THE Game_Board_Client SHALL remove the Targeted_Notification from view.
6. THE Game_Board_Client SHALL NOT block the target Team from any Region or control as a result of a Targeted_Notification.
7. IF appending the Game_Event for a confirmed wireframe targeting card play fails, THEN THE Game_Board_Client SHALL present an indication that the play was not delivered and SHALL NOT present a wireframe acknowledgement of success.
8. WHEN a Game_Board_Client of a Player on the target Team receives more than one wireframe targeting Game_Event, THE Game_Board_Client SHALL present a Targeted_Notification for each such Game_Event.

### Requirement 8: Real-time propagation on the Game Board

**User Story:** As a player, I want the game board to reflect events in near real time, so that targeted notifications and future live updates arrive without refreshing.

#### Acceptance Criteria

1. WHEN a Game_Board_Client opens the Game_Board for a Live_Game, THE Game_Board_Client SHALL subscribe to that Game's Real_Time_Channel.
2. WHEN a Game_Board_Client subscribes to a Game, THE Game_Board_Client SHALL load a snapshot computed by applying, in ascending sequence order, every Game_Event persisted for that Game before the subscription.
3. WHEN a Game_Board_Client receives Game_Events, THE Game_Board_Client SHALL apply them in ascending sequence order and ignore any Game_Event whose sequence is at or below its highest contiguously-applied sequence.
4. THE Real_Time_Channel SHALL deliver to a Game_Board_Client only Game_Events belonging to the Game the Game_Board_Client subscribed to.
5. IF a subscribed Game_Board_Client loses its Real_Time_Channel connection while active, THEN THE Game_Board_Client SHALL retry reconnection at intervals not exceeding 5 seconds for at most 12 attempts, and upon the 12th failed attempt SHALL enter a terminal state that indicates to the user that a reload is required.
6. WHEN a Game_Board_Client resumes from background or relaunch, THE Game_Board_Client SHALL apply every Game_Event with a sequence greater than its last persisted applied sequence, in ascending sequence order, before resuming live delivery.
7. WHEN a Game_Board_Client re-establishes its Real_Time_Channel connection within the reconnection attempt limit, THE Game_Board_Client SHALL apply every Game_Event with a sequence greater than its highest contiguously-applied sequence, in ascending sequence order, before resuming live delivery.
8. IF a Game_Board_Client fails to establish the Real_Time_Channel subscription or fails to load the pre-subscription snapshot when opening the Game_Board for a Live_Game, THEN THE Game_Board_Client SHALL present an indication that live updates are unavailable and that a reload is required, and SHALL NOT present partially-applied Game state as live.

### Requirement 9: Mobile-first Game Board interface

**User Story:** As a player walking the Beltline, I want the game board to work well on my phone, so that I can play one-handed without horizontal scrolling.

#### Acceptance Criteria

1. WHILE rendered on a viewport between 320 and 430 CSS pixels wide, THE Game_Board_Client SHALL present the active Region in a single-column layout whose content fits within the viewport width without horizontal scrolling, while vertical scrolling is permitted.
2. THE Game_Board_Client SHALL render each Region navigation control with a touch target of at least 44 by 44 CSS pixels.
3. THE Game_Board_Client SHALL render the placeholder claim control, each placeholder card play control, and the Targeted_Notification dismiss control with a touch target of at least 44 by 44 CSS pixels.
4. WHILE the Card_Play_Wireframe is presented on a viewport between 320 and 430 CSS pixels wide, THE Card_Play_Wireframe SHALL fit its content within the viewport width without horizontal scrolling.
5. WHILE the Targeted_Notification is presented, THE Game_Board_Client SHALL NOT obscure or prevent activation of the Region navigation controls.
