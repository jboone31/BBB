# Requirements Document

## Introduction

This feature implements the downstream gameplay behavior of all 23 Brawl Deck cards. The
`brawl-deck-architecture` spec already delivered draw-on-claim, keep/discard, the hand limit,
real `card_played` events with team/bar targeting and eligibility graying, and dev card
injection. A played card today only removes itself from the hand and records its targets;
nothing happens afterward.

This spec makes each card do what `.kiro/steering/cards.md` and `game-rules.md` say it does:
challenges that gate the target's claims until resolved, honor-system confirmation and
failure, Fairest of Them All mirroring, claim restrictions and timers, score effects through
the immutable score ledger, Power Hour's draw override, Voted Off the Island's claim removal,
host admin overrides, and the toasts every audience sees. It also replaces the placeholder
`CardText` in `lib/cards/catalog.ts` with the finalized copy from `docs/card-text-oracle.md`.

Binding decisions carried into these requirements:

- Fairest of Them All shows a dedicated, untimed prompt before the normal challenge actions;
  mirrored challenges cannot be mirrored again.
- The challenge claim gate applies as soon as a challenge is issued. The app has no
  "in line to order" exception; the host override covers edge cases.
- Use It or Lose It gates the target until its hand is empty; each card is played normally or
  discarded through an honor-system "Can't play, discard" action.
- Happy Hour awards +5 automatically on a claim during the window, and offers a one-time
  claim bonus action to a team that already claimed the bar.
- Voted Off the Island is a notice, not a gated challenge.
- Reused from `.kiro/specs/card-implementation/plan.md`: immutable score ledger,
  straight-line geodesic distance in miles, lazy server-time evaluation for correctness,
  honor-system manual confirmation, the `MutationResponse` envelope and stable error
  vocabulary, atomic domain writes with their `game_events` appends, and snapshot/reconnect
  folding.
- No database-side scheduler. The Supabase project has no in-database job scheduler and will
  not enable one. Claim, play, and bonus eligibility is always evaluated against server time
  read after the game lock; that is the correctness guarantee. Boards show start and end
  toasts locally at each boundary using the effect's start and end times plus a measured
  server-clock offset. Activation and expiry events are appended exactly once, either by a
  member-scoped settle nudge that boards call after each boundary and on mount or reconnect,
  or lazily before any card-behavior mutation. The `CRON_SECRET` cron route remains as an
  optional hook for an external scheduler. While no board is connected, toasts and events
  have no timing guarantee.
- Pioneer and Scenic Route cannot be played (or mirrored with Fairest of Them All) on a team
  that would be left with no Legal_Next_Bar. A team can still become stuck later, for example
  when other teams claim the remaining unclaimed bars after Pioneer is applied; the Host
  ending the restriction Effect is the escape for that case.
- Realtime delivery is backed by a recheck: boards refetch on reconnect and, while the game is
  live, poll for missed events after 15 seconds (one Recheck_Interval) without a new event, so
  every committed event reaches every connected member within the Delivery_Bound (the
  Recheck_Interval plus fetch latency and clock-offset error).

Out of scope: photo or video evidence upload, storage, or validation; walking-route distance;
verifying real-world drinking or location.

## Glossary

- **Card_Text_Catalog**: The typed player-facing card copy in `lib/cards/catalog.ts`, keyed by
  card slug, replacing `placeholderCardText`.
- **Card_Play_Service**: The server-side card-play mutation (`POST /api/games/{gameId}/cards/play`)
  and the per-card resolvers it invokes.
- **Challenge_Service**: The server-side mutations that resolve challenges: Mark complete,
  We failed, Use It or Lose It discards, and Fairest of Them All decisions.
- **Claim_Service**: The server-side claim mutation (`POST /api/games/{gameId}/claims`),
  including the Happy Hour claim bonus action.
- **Effect_Service**: The server-side logic that creates, evaluates, activates, consumes, and
  expires card effects using server time.
- **Timer_Sweep**: The idempotent server-side settlement step that appends the activation and
  expiry `game_events` entries for timed Effect transitions whose boundary is at or before
  current server time. The Timer_Sweep runs when invoked by the Settle_Nudge, lazily before any
  Card_Behavior_Mutation, or by the Cron_Route; no in-database scheduler drives the Timer_Sweep.
- **Settle_Nudge**: The member-scoped server endpoint that a connected board calls to run the
  Timer_Sweep for its own game and to read current server time.
- **Cron_Route**: The optional `CRON_SECRET`-protected route that runs the Timer_Sweep for an
  external scheduler.
- **Card_Behavior_Mutation**: Any mutation handled by the Card_Play_Service, Claim_Service
  (including Bonus_Claims), Challenge_Service, or Host_Override_Service.
- **Server_Clock_Offset**: The board's measured difference between server time and the device
  clock, taken from the server time returned by the Settle_Nudge.
- **Boundary_Toast**: A start toast or end toast tied to a timed Effect's start or end time.
- **Legal_Next_Bar**: For a team and a set of Next_Claim_Restrictions, a bar that is not the
  finish bar, is not actively claimed by that team, and satisfies every Next_Claim_Restriction
  in the set. A bar satisfies Pioneer when no other team holds an active claim on the bar. A bar
  satisfies Scenic Route when the bar has known coordinates and its Geodesic_Distance to the
  finish bar is strictly greater than that of the team's previous bar (Requirement 10.5).
  Temporary locks (Crop Dusting, Cancel Culture, Everyone's a Critic blocks, and the
  Challenge_Gate) are ignored because they expire.
- **Recheck_Interval**: 15 seconds, the longest a live board waits without a new event before
  fetching events it may have missed.
- **Delivery_Bound**: 20 seconds, the end-to-end guarantee for a committed event to reach a
  connected-and-staying-connected member's Board_Projection: one Recheck_Interval (15 s) plus up
  to 5 s for fetch latency and clock-offset error.
- **Host_Override_Service**: The server-side mutations available only to the game's host
  session (`games.admin_session_id`).
- **Scoring_Ledger**: The append-only `score_ledger_entries` table plus the pure scoring
  functions in `lib/scoring` that compute signed adjustments.
- **Board_Projection**: The pure fold in `lib/gameboard` that builds the client view from a
  snapshot and the `game_events` stream.
- **Board_UI**: The live board components under `components/board`, including the card hand,
  play panel, map, scoreboard, and toasts.
- **Host**: The session whose id equals `games.admin_session_id` for the game.
- **Caster**: The team that played a card.
- **Target_Team**: The team a team-targeting card was played on.
- **Uninvolved_Teams**: Teams in the game other than the Caster and the Target_Team.
- **Challenge**: A durable record created when a gated card is played on a team, with a
  status of `open`, `completed`, `failed`, or `cleared_by_host`.
- **Gated_Card**: A card whose catalog metadata has `completionRequired: true` and a team
  target: Go Piss Girl, Moneybags, Wired, Art School Dropout, Broad Shoulders, Bird Guide,
  Interested Buyer, Different Tastes, Everyone's a Critic, Spin Cycle, Dirty Bird, and Use It
  or Lose It.
- **Mirrorable_Card**: A card whose catalog `targetMode` is `team`: every Gated_Card plus
  Pioneer and Scenic Route.
- **Challenge_Gate**: The rule that a team with at least one `open` Challenge cannot claim a
  bar.
- **Mirrored_Challenge**: A Challenge created by Fairest of Them All on the original Caster,
  copying the original card and its entered values.
- **Effect**: A durable record of a card consequence with optional start time, end time,
  owner team, target team, target bar, and parameters (for example a bar lock, radius lock,
  next-claim restriction, score protection, phantom share, claim counter, or draw override).
- **Active_Effect**: An Effect whose start time is at or before current server time, whose end
  time is null or after current server time, and that has not been consumed or cancelled.
- **Next_Claim_Restriction**: An Effect (Pioneer or Scenic Route) that applies to and is
  consumed by the Target_Team's next successful bar claim.
- **Bonus_Claim**: The Happy Hour claim bonus action that awards +5 to a team that already
  claims the bar, without creating a new claim.
- **Scoring_Bar**: A bar that is neither the start bar nor the finish bar.
- **Geodesic_Distance**: The straight-line great-circle distance in miles between two bars'
  stored coordinates.
- **Toast**: A board notification. Kinds: target toast, others' toast, caster toast,
  announcement toast, start toast, end toast, payout toast, mirror toast, Fairest prompt, and
  host override toast.
- **Clock_Time**: A time rendered in the viewer's local time zone as `h:mm AM/PM`.
- **MutationResponse**: The envelope `{ applied: true, seq, result? }` or
  `{ applied: false, error, details? }` defined in the card-implementation plan.
- **Stable_Error**: One of `missing_session`, `not_member`, `not_authorized`,
  `invalid_input`, `not_found`, `conflict`, `blocked`, `expired`, `already_resolved`,
  `unavailable`.

## Requirements

### Requirement 1: Finalized card text in code

**User Story:** As a player, I want each card in my hand to show its real wording, so that I
know what it requires, what it does, and who it hits.

#### Acceptance Criteria

1. THE Card_Text_Catalog SHALL define, for every card slug, the fields `requires`
   (string or null), `effect` (string), `targetNote` (string), `targetToastBody` (string or
   null), and an optional `toasts` object holding per-card overrides for announcement, start,
   end, payout, mirror, and Everyone's a Critic actions.
2. THE Card_Text_Catalog SHALL contain, for every card slug, the Requires, Effect, Target,
   target toast, and per-card toast copy stated in `docs/card-text-oracle.md`, character for
   character apart from template placeholders.
3. THE Card_Text_Catalog SHALL express caster-entered values and names as named template
   placeholders (`{Caster}`, `{Target}`, `{CARD}`, `{Bar}`, `{color1}`, `{color2}`, `{color3}`,
   `{duration}`, `{cuisine}`, `{startTime}`, `{endTime}`).
4. IF a card slug lacks a non-empty `effect` or `targetNote`, or a card with a team target lacks
   a non-empty `targetToastBody`, THEN THE Card_Text_Catalog SHALL throw an error at module load.
5. THE Card_Text_Catalog SHALL remove `placeholderCardText` and the `description`,
   `castingRequirement`, and `targetRequirement` fields, and every consumer of the old fields
   SHALL read the new fields.
6. WHEN a player inspects a held card, THE Board_UI SHALL show the card's Requires text first
   (when present), then its Effect text, then its Target note.
7. THE Card_Text_Catalog SHALL keep catalog metadata consistent with this spec, including Happy
   Hour carrying no target-team confirmation requirement and Pioneer and Scenic Route carrying
   `completionRequired: false`, so that the metadata-derived Gated_Card set equals the
   Gated_Card list in the Glossary.

### Requirement 2: Oracle document update

**User Story:** As the game designer, I want the oracle to match the Fairest of Them All flow
we chose, so that the copy document and the app agree.

#### Acceptance Criteria

1. THE `docs/card-text-oracle.md` document SHALL describe the Fairest of Them All prompt as a
   dedicated toast shown to the holding Target_Team before that team's normal challenge
   actions, replacing the "inside the holder's target toast" wording.
2. THE `docs/card-text-oracle.md` document SHALL state that a Mirrored_Challenge cannot be
   mirrored again.
3. THE `docs/card-text-oracle.md` document SHALL record that the Card_Text_Catalog is the
   in-code home of the copy and that the `CardText` reshape is complete.
4. THE `docs/card-text-oracle.md` document SHALL update its status line from a "first-pass
   proposition" with "nothing is locked" to a locked status that names `lib/cards/cardText.ts`
   as the in-code source of truth for card copy.

### Requirement 3: Toast templates and audiences

**User Story:** As a player, I want to see the right message for my role whenever a card is
played, so that every team learns about plays immediately and the targeted team knows what to
do.

#### Acceptance Criteria

1. WHEN a card is played on a team, THE Board_UI SHALL show the Target_Team a target toast
   with the headline "{Caster} has played {CARD} on you!" and the card's `targetToastBody` as
   its body.
2. WHEN a card is played, THE Board_UI SHALL show the Caster a caster toast using the standard
   template for the card's target kind ("You played {CARD} on {Target}.", "You played {CARD} on
   {Bar}.", or "You played {CARD}.").
3. WHEN a card is played, THE Board_UI SHALL show every team other than the Caster and the
   Target_Team a dismissable others' toast with the standard headline for the card's target
   kind and the card's Effect text inside an expandable dropdown.
4. WHERE a card's Card_Text_Catalog entry defines an announcement or all-teams toast override,
   THE Board_UI SHALL show that override text to the non-casting teams in place of the standard
   others' headline.
5. WHEN a card with caster-entered values is played, THE Board_UI SHALL fill the entered values
   into the target toast body and the others' toast dropdown.
6. THE Board_UI SHALL render durations in `m:ss` format (for example 90 seconds as `1:30`) and
   start and end times as Clock_Time.
7. WHEN a timed effect for Crop Dusting, Cancel Culture, Happy Hour, or Power Hour ends, THE
   Board_UI SHALL show every team the card's dismissable end toast, with timing and catch-up
   as defined in Requirement 20.
8. THE Board_UI SHALL keep a Toast that offers an action visible until the action's underlying
   decision is recorded or cleared by the Host.
9. WHEN a board session reloads or reconnects, THE Board_Projection SHALL reconstruct every
   Toast whose action is still pending.
10. THE Card_Text_Catalog SHALL omit the Challenge_Gate rule from all card copy, and THE
    Board_UI SHALL present the Challenge_Gate as a standard claim-blocked message.

### Requirement 4: Challenge issuance and the claim gate

**User Story:** As a targeted team, I want challenges to block our next claim until we resolve
them, so that the game enforces the rules without a referee.

#### Acceptance Criteria

1. WHEN a Gated_Card is played on a Target_Team, THE Card_Play_Service SHALL create one `open`
   Challenge for that Target_Team in the same transaction as the `card_played` event.
2. WHILE a team has at least one `open` Challenge, THE Claim_Service SHALL reject that team's
   claims and Bonus_Claims with the Stable_Error `blocked`, with details naming each blocking
   Challenge's card.
3. THE Claim_Service SHALL apply the Challenge_Gate from the moment the Challenge is committed.
4. WHILE a team has more than one `open` Challenge, THE Challenge_Service SHALL accept
   resolution of those Challenges in any order.
5. WHEN a team attempts to claim a bar while gated, THE Board_UI SHALL show that team which
   Challenges must be resolved before claiming.
6. THE Challenge_Service SHALL record the resolving session, resolving team, server timestamp,
   and resulting status for every Challenge resolution.

### Requirement 5: Honor-system completion

**User Story:** As a targeted team, I want to mark a challenge complete once we've done it, so
that we can keep claiming bars.

#### Acceptance Criteria

1. WHILE a Gated_Card Challenge other than Everyone's a Critic or Use It or Lose It is `open`
   and no Fairest of Them All decision is pending for that Challenge, THE Board_UI SHALL show
   the Target_Team a Mark complete action on the target toast.
2. WHEN a member of the Target_Team submits Mark complete for an `open` Challenge, THE
   Challenge_Service SHALL set the Challenge status to `completed` and append exactly one
   `game_events` entry in the same transaction.
3. IF a session that is not a member of the Challenge's Target_Team submits a resolution, THEN
   THE Challenge_Service SHALL reject the request with `not_authorized` and write nothing.
4. IF a resolution is submitted for a Challenge that is not `open`, THEN THE Challenge_Service
   SHALL reject the request with `already_resolved` and write nothing.
5. WHILE a Fairest of Them All decision is pending for a Challenge, THE Challenge_Service SHALL
   reject Mark complete, We failed, and Use It or Lose It "Can't play, discard" for that
   Challenge with `conflict`.

### Requirement 6: Cards with caster-entered values

**User Story:** As a casting team, I want to enter the colors, duration, or cuisine my card
needs, so that the target sees exactly what to match.

#### Acceptance Criteria

1. WHEN Art School Dropout is played, THE Card_Play_Service SHALL require exactly three distinct
   colors from the set red, orange, yellow, green, blue, indigo, violet.
2. WHEN Bird Guide is played, THE Card_Play_Service SHALL require an integer duration from 0 to
   300 seconds inclusive.
3. WHEN Different Tastes is played, THE Card_Play_Service SHALL require a cuisine string of 1 to
   60 characters after trimming whitespace.
4. IF a required caster-entered value is missing or invalid, THEN THE Card_Play_Service SHALL
   reject the play with `invalid_input` and leave the card in the Caster's hand.
5. THE Card_Play_Service SHALL store the validated values on the play and the resulting
   Challenge so that the target toast, others' dropdown, and any Mirrored_Challenge reuse them.
6. WHEN a player plays a card that has a Requires text, THE Board_UI SHALL display the Requires
   text in the play flow before the player confirms the play.

### Requirement 7: Everyone's a Critic

**User Story:** As a team targeted by Everyone's a Critic, I want to report success or failure,
so that a failed attempt applies the 15-minute penalty.

#### Acceptance Criteria

1. WHILE an Everyone's a Critic Challenge is `open` and no Fairest of Them All decision is
   pending for it, THE Board_UI SHALL show the Target_Team the actions Mark complete and We
   failed.
2. WHEN the Target_Team submits We failed, THE Challenge_Service SHALL set the Challenge status
   to `failed` and create a team claim block Effect for the Target_Team ending 15 minutes after
   the failure's server timestamp, in one transaction with exactly one `game_events` entry.
3. WHILE an Everyone's a Critic claim block Effect is active for a team, THE Claim_Service
   SHALL reject that team's claims and Bonus_Claims with `blocked`.
4. WHEN the Target_Team submits Mark complete, THE Challenge_Service SHALL set the Challenge
   status to `completed` with no claim block.

### Requirement 8: Use It or Lose It

**User Story:** As a team hit by Use It or Lose It, I want to clear my hand by playing or
discarding each card, so that we can resume claiming.

#### Acceptance Criteria

1. WHEN Use It or Lose It is played on a Target_Team, THE Card_Play_Service SHALL create an
   `open` Challenge that remains `open` while the Target_Team holds any card in hand or has an
   unresolved pending draw.
2. WHILE a Use It or Lose It Challenge is `open`, THE Board_UI SHALL show the Target_Team a
   "Can't play, discard" action on each card in its hand.
3. WHEN the Target_Team submits "Can't play, discard" for a held card, THE Challenge_Service
   SHALL discard that card for the rest of the game with exactly one `game_events` entry.
4. WHILE a Use It or Lose It Challenge is `open`, THE Card_Play_Service SHALL accept plays from
   the Target_Team's hand through the normal play flow.
5. WHEN the Target_Team's hand becomes empty and no pending draw remains, THE Challenge_Service
   SHALL set the Use It or Lose It Challenge status to `completed` in the same transaction as
   the play or discard that emptied the hand.
6. IF Use It or Lose It is played on a Target_Team whose hand is already empty with no pending
   draw, THEN THE Card_Play_Service SHALL create the Challenge with status `completed`.
7. THE Challenge_Service SHALL leave every card in the Target_Team's hand in place until the
   Target_Team plays or discards that card.

### Requirement 9: Fairest of Them All prompt

**User Story:** As a targeted team holding Fairest of Them All, I want a clear choice to mirror
the challenge, so that I can make the casting team suffer it too.

#### Acceptance Criteria

1. WHEN a Mirrorable_Card that is not a Mirrored_Challenge is played on a Target_Team holding
   Fairest of Them All, THE Board_UI SHALL show that team a dedicated Fairest prompt with the
   text "Play FAIREST OF THEM ALL to make {Caster} complete this challenge too?" and the actions
   Play and Decline, subject to criterion 15 for Pioneer and Scenic Route.
2. THE Board_UI SHALL keep the Fairest prompt open with no time limit until the Target_Team
   chooses Play or Decline.
3. WHILE a Fairest prompt is pending for a Challenge, THE Board_UI SHALL hide that Challenge's
   Mark complete, We failed, and Use It or Lose It "Can't play, discard" actions.
4. WHEN the Target_Team chooses Decline, THE Challenge_Service SHALL record the decline with
   exactly one `game_events` entry, and THE Board_UI SHALL then show the Challenge's normal
   actions.
5. WHEN the Target_Team chooses Play, THE Challenge_Service SHALL, in one transaction, move
   Fairest of Them All from the Target_Team's hand to played, create a Mirrored_Challenge on
   the original Caster with the original card and entered values, and append exactly one
   `game_events` entry.
6. WHEN a Mirrored_Challenge is created, THE Board_UI SHALL show the original Caster a mirror
   toast with the headline "{Target} played FAIREST OF THEM ALL! Your team must also complete
   {CARD}." and the original card's target toast body with the same entered values.
7. WHEN a Mirrored_Challenge is created, THE Board_UI SHALL show the Uninvolved_Teams an others'
   toast with the headline "{Target} turned {CARD} back on {Caster} with FAIREST OF THEM ALL!".
8. THE Challenge_Service SHALL leave the Target_Team's original Challenge in place when Fairest
   of Them All is played.
9. WHEN a Mirrored_Challenge is created, THE Challenge_Service SHALL apply the same effect to
   the original Caster that the original card applies to a Target_Team, including the
   Challenge_Gate, Everyone's a Critic actions, Use It or Lose It hand clearing, and Pioneer or
   Scenic Route Next_Claim_Restrictions.
10. THE Board_UI SHALL omit a Fairest prompt for a Mirrored_Challenge, including when the
    original Caster holds Fairest of Them All.
11. IF Fairest of Them All is submitted through the normal card-play flow, THEN THE
    Card_Play_Service SHALL reject the play with `invalid_input`.
12. IF the Fairest of Them All card leaves the Target_Team's hand, or the Challenge is cleared by
    the Host, before the Target_Team decides, THEN THE Board_UI SHALL close the Fairest prompt.
13. WHEN Fairest of Them All is played on one Challenge, THE Board_UI SHALL close every other
    Fairest prompt pending for the Target_Team.
14. THE Card_Play_Service SHALL exclude Mirrored_Challenges from the rule that no team may be
    targeted by a card of the same name more than once.
15. WHEN Pioneer or Scenic Route is played on a Target_Team holding Fairest of Them All, THE
    Card_Play_Service SHALL offer the Fairest prompt only when the original Caster would have at
    least one Legal_Next_Bar for the Caster's active Next_Claim_Restrictions plus the mirrored
    restriction, evaluated at the play's server time.
16. WHEN the Target_Team chooses Play on a Fairest prompt for Pioneer or Scenic Route, THE
    Challenge_Service SHALL re-evaluate the criterion 15 Legal_Next_Bar check against the state
    at the decision's server time.
17. IF the criterion 16 re-evaluation finds that the original Caster would have no
    Legal_Next_Bar, THEN THE Challenge_Service SHALL reject Play with `invalid_input`, write
    nothing, and leave the Fairest prompt pending.
18. WHILE a pending Fairest prompt for Pioneer or Scenic Route would leave the original Caster
    with no Legal_Next_Bar, THE Board_UI SHALL show in the prompt that the mirror is no longer
    legal and why, and SHALL keep the Decline action available.

### Requirement 10: Pioneer and Scenic Route

**User Story:** As a team, I want the app to enforce claim restrictions on my opponents' next
claim, so that my Pioneer and Scenic Route cards have teeth.

#### Acceptance Criteria

1. WHEN Pioneer is played on a Target_Team, THE Card_Play_Service SHALL create a
   Next_Claim_Restriction for the Target_Team.
2. WHILE a Pioneer Next_Claim_Restriction is active for a team, THE Claim_Service SHALL reject
   that team's claim of the finish bar or of any bar with an active claim by another team, with
   `blocked`.
3. WHEN Scenic Route is played on a Target_Team, THE Card_Play_Service SHALL create a
   Next_Claim_Restriction for the Target_Team.
4. WHILE a Scenic Route Next_Claim_Restriction is active for a team, THE Claim_Service SHALL
   reject that team's claim of any bar whose Geodesic_Distance to the finish bar is less than or
   equal to the Geodesic_Distance from the team's previous bar to the finish bar, with
   `blocked`.
5. THE Effect_Service SHALL define a team's previous bar as the bar of the team's most recent
   claim that was not reversed by an ordinary unclaim, and as the start bar when no such claim
   exists.
6. WHEN a team with an active Next_Claim_Restriction successfully claims a bar, THE
   Claim_Service SHALL consume every Next_Claim_Restriction for that team in the same
   transaction.
7. THE Claim_Service SHALL neither apply nor consume Next_Claim_Restrictions for Bonus_Claims.
8. THE Board_UI SHALL show Pioneer and Scenic Route target toasts as notices without a Mark
   complete action.
9. WHILE a team has an active Next_Claim_Restriction, THE Board_UI SHALL mark on that team's map
   the bars the restriction blocks.
10. IF Pioneer or Scenic Route is played on a Target_Team that would have no Legal_Next_Bar for
    the Target_Team's active Next_Claim_Restrictions plus the restriction being added, THEN THE
    Card_Play_Service SHALL reject the play with `invalid_input` and leave the card in the
    Caster's hand.
11. THE Card_Play_Service SHALL apply criterion 10 when Pioneer and Scenic Route Next_Claim_Restrictions
    stack on one team, so that a team holding one of the two restrictions can receive the other
    only when a bar satisfies both.
12. WHILE the Caster is choosing a Pioneer or Scenic Route target, THE Board_UI SHALL gray out
    each team that criterion 10 would reject and show the reason that the team would have no
    legal next bar.

Note: criterion 10 is evaluated at play time. A team can still become unable to claim any bar
later, for example when other teams claim the remaining unclaimed bars after Pioneer is applied.
The Host ending the Next_Claim_Restriction Effect (Requirement 21.11) is the escape for that
case.

### Requirement 11: Crop Dusting

**User Story:** As a casting team, I want Crop Dusting to lock the bar I'm in for 15 minutes, so
that other teams have to go elsewhere.

#### Acceptance Criteria

1. IF Crop Dusting targets the finish bar, THEN THE Card_Play_Service SHALL reject the play with
   `invalid_input`.
2. WHEN Crop Dusting is played on a bar, THE Card_Play_Service SHALL create a bar lock Effect on
   that bar that starts at the play's server timestamp and ends 15 minutes later.
3. WHILE a Crop Dusting bar lock is active on a bar, THE Claim_Service SHALL reject claims and
   Bonus_Claims of that bar by every team other than the Caster, with `blocked`.
4. WHEN Crop Dusting is played, THE Board_UI SHALL show the non-casting teams the others' toast
   body "No team may enter or claim {Bar} until {endTime}."
5. WHEN a Crop Dusting bar lock ends, THE Board_UI SHALL show every team "CROP DUSTING has ended.
   {Bar} can be claimed again."
6. WHILE a Crop Dusting bar lock is active, THE Board_UI SHALL mark the locked bar on the map for
   every team other than the Caster.

### Requirement 12: Cancel Culture

**User Story:** As a casting team, I want Cancel Culture to shut down an area after a delay, so
that I can disrupt opponents' routes.

#### Acceptance Criteria

1. IF Cancel Culture targets a bar whose Geodesic_Distance to the finish bar is less than or equal
   to 0.25 miles, THEN THE Card_Play_Service SHALL reject the play with `invalid_input`.
2. WHILE the Caster is choosing a Cancel Culture target, THE Board_UI SHALL gray out bars within
   0.25 miles of the finish bar in the target picker.
3. WHEN Cancel Culture is played on a bar, THE Card_Play_Service SHALL create a radius lock Effect
   centered on that bar that starts 15 minutes after the play's server timestamp and ends 30
   minutes after it.
4. WHILE a Cancel Culture radius lock is active, THE Claim_Service SHALL reject claims and
   Bonus_Claims by every team of every bar whose Geodesic_Distance to the target bar is less than
   or equal to 0.25 miles, with `blocked`.
5. WHEN Cancel Culture is played, THE Board_UI SHALL show every non-casting team the announcement
   toast naming the bar and the start Clock_Time.
6. WHEN a Cancel Culture radius lock starts, THE Board_UI SHALL show every team the start toast
   with the end Clock_Time.
7. WHEN a Cancel Culture radius lock ends, THE Board_UI SHALL show every team "CANCEL CULTURE has
   ended. Bars near {Bar} can be claimed again."
8. WHILE a Cancel Culture radius lock is pending or active, THE Board_UI SHALL mark the target bar
   and its 0.25-mile zone on every team's map, distinguishing pending from active.

### Requirement 13: Happy Hour

**User Story:** As a team, I want Happy Hour to reward the first drink at a bar for an hour, so
that the card creates a reason to visit.

#### Acceptance Criteria

1. IF Happy Hour targets the finish bar, THEN THE Card_Play_Service SHALL reject the play with
   `invalid_input`.
2. WHEN Happy Hour is played on a bar, THE Card_Play_Service SHALL create a bonus window Effect on
   that bar that starts at the play's server timestamp and ends 60 minutes later.
3. WHEN a team claims a bar during that bar's Happy Hour window and has not received that window's
   bonus, THE Claim_Service SHALL append a +5 Happy Hour entry to the Scoring_Ledger for that team
   in the claim transaction, alongside the normal share.
4. WHILE a Happy Hour window is active on a bar, THE Board_UI SHALL show a "Claim bonus" action to
   each team that holds an active claim on that bar and has not received that window's bonus.
5. WHEN a team submits a Bonus_Claim during an active Happy Hour window, THE Claim_Service SHALL
   append a +5 Happy Hour entry to the Scoring_Ledger for that team with exactly one
   `game_events` entry, without creating a claim or a card draw.
6. IF a team that already received a Happy Hour window's bonus submits another Bonus_Claim or
   claims the bar again within that window, THEN THE Claim_Service SHALL award no additional Happy
   Hour bonus, and a repeated Bonus_Claim SHALL be rejected with `already_resolved`.
7. IF a Bonus_Claim is submitted after the window's end time, THEN THE Claim_Service SHALL reject
   it with `expired`.
8. THE Scoring_Ledger SHALL leave Happy Hour bonuses unchanged when the bar's normal share changes.
9. WHEN a team reverses a claim through an ordinary unclaim, THE Claim_Service SHALL reverse any
   Happy Hour bonus awarded by that claim with a signed Scoring_Ledger entry.
10. WHEN a Happy Hour window ends, THE Board_UI SHALL show every team "HAPPY HOUR at {Bar} has
    ended."

### Requirement 14: Party Crasher

**User Story:** As a casting team, I want Party Crasher to shrink everyone's share at a bar, so
that contested bars are worth less to my opponents.

#### Acceptance Criteria

1. IF Party Crasher targets the finish bar or a bar with four active claimants, THEN THE
   Card_Play_Service SHALL reject the play with `invalid_input`.
2. WHILE Party Crasher is in effect on a bar with fewer than four active claimants, THE
   Scoring_Ledger SHALL compute each claimant's share as 12 divided by the number of active
   claimants plus one.
3. WHILE Party Crasher is in effect on a bar with four active claimants, THE Scoring_Ledger SHALL
   compute each claimant's share as 3.
4. WHEN Party Crasher is played on a bar with active claimants, THE Card_Play_Service SHALL append
   signed share-correction entries to the Scoring_Ledger for those claimants in the play
   transaction.
5. WHEN a bar under Party Crasher gains or loses a claimant, THE Claim_Service SHALL append share
   corrections computed with the Party Crasher share rule.
6. THE Party Crasher Effect SHALL persist on the bar for the rest of the game.

### Requirement 15: Insurance

**User Story:** As a team, I want Insurance to protect our next bar's points, so that late
arrivals can't dilute our share.

#### Acceptance Criteria

1. WHEN Insurance is played, THE Card_Play_Service SHALL create a score protection Effect for the
   Caster that attaches to the Caster's next successful claim.
2. WHEN the Caster's next claim succeeds, THE Claim_Service SHALL record the Caster's share at that
   moment as the protected share for that bar and consume the pending protection.
3. WHILE a protected share exists for a team on a bar, THE Scoring_Ledger SHALL hold that team's
   share on that bar at or above the protected share when other teams claim the bar or Party
   Crasher is applied to it.
4. THE Scoring_Ledger SHALL compute other claimants' shares on a protected bar with the normal
   share rule.
5. IF the protected team's claim on the bar is removed by an ordinary unclaim or Voted Off the
   Island, THEN THE Scoring_Ledger SHALL remove the protected share for that bar.
6. THE Claim_Service SHALL neither apply nor consume Insurance for Bonus_Claims.

### Requirement 16: Patient Investor

**User Story:** As a team, I want Patient Investor to pay out after we claim four more bars, so
that steady progress is rewarded.

#### Acceptance Criteria

1. WHEN Patient Investor is played, THE Card_Play_Service SHALL create a claim counter Effect for
   the Caster starting at zero.
2. WHEN the Caster successfully claims a bar not already counted by that counter, THE Claim_Service
   SHALL increment the counter in the claim transaction.
3. WHEN an ordinary unclaim reverses a counted claim before payout, THE Claim_Service SHALL
   decrement the counter.
4. WHEN the counter reaches four, THE Claim_Service SHALL append a +6 Patient Investor entry to the
   Scoring_Ledger and consume the Effect in the same transaction as the fourth claim, including
   when the fourth claim is the finish bar.
5. THE Scoring_Ledger SHALL leave the Patient Investor award unchanged by later claim changes.
6. WHEN the Patient Investor award is appended, THE Board_UI SHALL show every team "{Caster}
   cashed in PATIENT INVESTOR for +6 points!"
7. THE Claim_Service SHALL exclude Bonus_Claims from the counter.

### Requirement 17: Power Hour

**User Story:** As a team, I want Power Hour to let every team keep both drawn cards for 20
minutes, so that card play accelerates.

#### Acceptance Criteria

1. WHEN Power Hour is played, THE Card_Play_Service SHALL create a draw override Effect for every
   team that starts at the play's server timestamp and ends 20 minutes later.
2. WHILE a Power Hour draw override is active, THE Claim_Service SHALL have each team that claims a
   non-finish bar draw two cards and keep both, with the existing play-or-discard prompt applied
   before any card beyond the hand limit enters the hand.
3. WHILE more than one Power Hour draw override overlaps, THE Effect_Service SHALL treat the draw
   override as active until the latest end time.
4. WHEN a Power Hour draw override ends, THE Board_UI SHALL show every team "POWER HOUR has ended.
   Draws are back to normal."

### Requirement 18: Voted Off the Island

**User Story:** As a casting team, I want to knock an opponent off a bar every team has claimed,
so that I can take back points.

#### Acceptance Criteria

1. THE Card_Play_Service SHALL treat a bar as qualifying for Voted Off the Island when the bar is
   not the start bar and every team in the game holds an active claim on the bar.
2. IF Voted Off the Island is played with a bar that does not qualify or a team that is the Caster,
   THEN THE Card_Play_Service SHALL reject the play with `invalid_input`.
3. WHEN Voted Off the Island is played, THE Board_UI SHALL gray out non-qualifying bars, then gray
   out ineligible teams, in the existing bar-then-team target flow.
4. WHEN Voted Off the Island is played, THE Card_Play_Service SHALL revoke the Target_Team's claim
   on the chosen bar with the revoke reason `voted_off` and append share corrections for the
   remaining claimants, in the play transaction.
5. THE Card_Play_Service SHALL create no Challenge and no Challenge_Gate for Voted Off the Island.
6. WHEN the Target_Team later claims that bar again, THE Claim_Service SHALL accept the claim under
   the normal claim rules and draw no cards for it.
7. THE Scoring_Ledger SHALL leave Happy Hour and Patient Investor awards unchanged when a claim is
   removed by Voted Off the Island.
8. WHEN Voted Off the Island is played, THE Board_UI SHALL show the Target_Team "Your team's claim
   on {Bar} has been removed. You may re-claim it later." and the Uninvolved_Teams "{Caster} played
   VOTED OFF THE ISLAND on {Target} at {Bar}!".

Note: criterion 1 intentionally reads `cards.md`'s "a bar all other teams have claimed" as every
team in the game, including the Caster, holding an active claim on the bar. `docs/card-text-oracle.md`
matches this reading. This is a wording clarification, not a behavior change.

### Requirement 19: Claim evaluation order and atomicity

**User Story:** As a player, I want claims and card effects to agree even when they happen at the
same moment, so that the board never shows an impossible state.

#### Acceptance Criteria

1. THE Claim_Service SHALL evaluate the Challenge_Gate, Everyone's a Critic blocks, Crop Dusting
   locks, Cancel Culture locks, and Next_Claim_Restrictions against current server time before
   recording a claim.
2. THE Claim_Service SHALL serialize claim, card-play, resolution, and Host override mutations per
   game, so that each mutation evaluates against all Effects committed before it.
3. WHEN a claim is rejected because of a card effect, THE Claim_Service SHALL return the Stable_Error
   `blocked` with details listing every blocking card and, for timed blocks, the server end time.
4. WHEN a claim succeeds, THE Claim_Service SHALL commit the claim, its share entries, card-effect
   score entries, Effect consumption, counter updates, the card draw, and their `game_events`
   entries in one transaction.
5. IF any write in a card-behavior mutation fails, THEN THE Card_Play_Service, Claim_Service,
   Challenge_Service, Host_Override_Service, and Timer_Sweep SHALL roll back the whole mutation and
   return `unavailable` without appending any `game_events` entry.
6. THE Challenge_Service, Host_Override_Service, and Bonus_Claim action SHALL each append exactly
   one `game_events` entry per applied mutation, and THE Timer_Sweep SHALL append exactly one
   `game_events` entry per Effect transition (Requirement 20.4).
7. THE Card_Play_Service SHALL commit the play's Challenges, Effects, claim removals, and score
   entries in the same transaction as its `card_played` event.
8. THE Card_Play_Service, Claim_Service, Challenge_Service, and Host_Override_Service SHALL respond
   with the MutationResponse envelope and Stable_Error values for every new rejection introduced by
   this spec.
9. WHEN a Card_Behavior_Mutation for a game begins, THE Timer_Sweep SHALL append every due,
   unannounced activation and expiry event for that game under the game lock before the mutation
   is evaluated.
10. THE Card_Play_Service, Claim_Service, Challenge_Service, and Host_Override_Service SHALL exclude
    the Timer_Sweep's transition events from every "exactly one `game_events` entry" and "write
    nothing" condition in this spec, including when the mutation itself is rejected.

### Requirement 20: Timed effects and server time

**User Story:** As a player, I want timers to start and end on time for everyone, so that no team
gets an unfair head start.

#### Acceptance Criteria

1. THE Effect_Service SHALL determine every Effect's start, end, and active state from database
   server timestamps.
2. THE Effect_Service SHALL treat an Effect as active at time t when its start time is at or before
   t and its end time is after t.
3a. WHILE a board is connected, WHEN a timed Effect's start time or end time passes, THE Board_UI
    SHALL show the corresponding Boundary_Toast within 2 seconds of the boundary as measured by
    the device clock corrected by the Server_Clock_Offset.
3b. WHEN a timed Effect's start time or end time passes, THE Timer_Sweep SHALL append exactly one
    activation or expiry `game_events` entry for that transition no later than the next
    Card_Behavior_Mutation or Settle_Nudge call for that game after the boundary.
3c. THE Claim_Service and Card_Play_Service SHALL enforce timed claim, play, and bonus rules
    against server time whether or not the activation or expiry event for the transition exists.
3d. WHILE no board for a game is connected, THE Board_UI and Timer_Sweep SHALL carry no timing
    guarantee for when that game's Boundary_Toasts are shown or its transition events are
    appended. Once a transition event is committed, its delivery is governed by Requirement
    23.8 like any other event.
4. WHEN the Timer_Sweep runs more than once for the same Effect transition, from any combination
   of Settle_Nudge calls, Card_Behavior_Mutations, and Cron_Route calls, THE Timer_Sweep SHALL
   append no additional events.
5a. THE Cron_Route SHALL require the shared cron secret and refuse to run when the secret is not
    configured.
5b. IF a session that is not a member of the game calls the Settle_Nudge, THEN THE Settle_Nudge
    SHALL reject the request with `missing_session` or `not_member` and write nothing.
5c. THE Settle_Nudge SHALL append only transition events whose boundary is at or before the
    server time read after the game lock.
6. WHEN a game ends, THE Effect_Service SHALL end all of that game's Effects and THE Board_UI SHALL
   show no end toasts for them.
7. WHILE a timed Effect is active, THE Board_UI SHALL display its remaining time computed from
   server timestamps and the Server_Clock_Offset.
8. WHILE a game is live and a board is connected, THE Board_UI SHALL call the Settle_Nudge on
   mount, on reconnect, and within 5 seconds after each known Effect start or end time.
9. WHEN the Board_UI receives server time from the Settle_Nudge, THE Board_UI SHALL update the
   Server_Clock_Offset from that server time, adjusted by half the request round trip.
10. WHEN a board reloads or reconnects, THE Board_UI SHALL show each Boundary_Toast whose boundary
    passed while the board was away, excluding toasts recorded as dismissed in the board's
    existing dismissal record.
11. IF the game has ended, THEN THE Board_UI SHALL suppress Boundary_Toasts whose boundary passed
    while the board was away.
12. THE Board_UI SHALL show each Boundary_Toast at most once per board, whether the toast is
    triggered by the local boundary timer or by the activation or expiry event.

### Requirement 21: Host admin overrides

**User Story:** As the host, I want to fix mistakes with challenges and effects, so that a
mis-tap or an edge case doesn't ruin the game.

#### Acceptance Criteria

1. WHEN the Host clears an `open` Challenge, THE Host_Override_Service SHALL set its status to
   `cleared_by_host` and lift its Challenge_Gate.
2. WHEN the Host resets a `completed` or `failed` Challenge, THE Host_Override_Service SHALL
   set its status to `open` and reinstate its Challenge_Gate, except that IF the Challenge is
   Use It or Lose It and its Target_Team has an empty hand and no pending draw, THEN THE
   Host_Override_Service SHALL reject the reset with `conflict` and write nothing. (Such a
   Challenge could never complete again, so a reset would leave the target permanently
   gated.)
3. WHEN the Host resets a `failed` Everyone's a Critic Challenge, THE Host_Override_Service SHALL
   cancel the claim block Effect created by that failure.
4. WHEN the Host ends an Effect early, THE Host_Override_Service SHALL mark the Effect cancelled at
   the current server time, covering Crop Dusting, Cancel Culture (pending or active), Happy Hour,
   Power Hour, Everyone's a Critic blocks, Next_Claim_Restrictions, Insurance, Party Crasher, and
   Patient Investor Effects.
5. WHEN the Host ends a Party Crasher Effect or an Insurance protected share, THE
   Host_Override_Service SHALL append share corrections that restore the normal share rule for the
   affected bar.
6. THE Host_Override_Service SHALL leave Happy Hour and Patient Investor awards already in the
   Scoring_Ledger unchanged when the Host ends their Effects.
7. THE Host_Override_Service SHALL commit each override and exactly one `game_events` entry in one
   transaction.
8. WHEN a Host override is applied, THE Board_UI SHALL show every team a host override toast naming
   the card and the change.
9. IF a session other than the Host submits an override, THEN THE Host_Override_Service SHALL reject
   the request with `not_authorized` and write nothing.
10. WHILE the game is live, THE Board_UI SHALL show the Host a list of every Challenge and every
    pending or active Effect with the override actions valid for each.
11. WHILE a Pioneer or Scenic Route Next_Claim_Restriction is unconsumed, THE Board_UI SHALL offer
    the Host an End effect action for that restriction, and THE Host_Override_Service SHALL cancel
    the restriction so that the Claim_Service no longer applies it.

### Requirement 22: Card-play validation per card

**User Story:** As a player, I want the target picker and server to agree on which targets are
legal for each card, so that I can't waste a card on an invalid target.

#### Acceptance Criteria

1. THE Card_Play_Service SHALL apply the eligibility rules in Requirements 11 through 18 on the
   server, and THE Board_UI SHALL gray out the same ineligible targets in the target picker.
2. IF a play targets an ineligible team or bar, THEN THE Card_Play_Service SHALL reject the play with
   `invalid_input` and leave the card in the Caster's hand.
3. IF a card is played while the game is not live, THEN THE Card_Play_Service SHALL reject the play
   with `conflict` and write nothing.
4. WHEN Insurance, Patient Investor, or Power Hour is played, THE Card_Play_Service SHALL accept the
   play without a target.
5. THE Card_Play_Service SHALL apply the Pioneer and Scenic Route Legal_Next_Bar guard (Requirement
   10.10) on the server, and THE Board_UI SHALL gray out the same teams with the same reason.

### Requirement 23: Projection and reconnect

**User Story:** As a player who reloads or loses signal, I want the board to show the exact current
card state, so that I never act on stale information.

#### Acceptance Criteria

1. THE Board_Projection SHALL fold challenge, Fairest decision, effect, score, claim, and
   notification events into the board view from a snapshot plus the event tail.
2. WHEN the same event is delivered more than once, THE Board_Projection SHALL apply it once.
3. FOR ALL event sequences, folding the full log from the start SHALL produce the same Challenges,
   Effects, notifications, claims, and scores as folding a snapshot plus the remaining tail.
4. FOR ALL Scoring_Ledger contents, THE Board_Projection SHALL compute each team's score as the sum
   of that team's ledger entries.
5. THE Board_Projection SHALL fold only events whose game id matches the board's game.
6. WHEN a board reconnects, THE Board_UI SHALL refetch the snapshot plus the event tail and fold
   them into the Board_Projection.
7. WHILE the game is live, WHEN one Recheck_Interval passes without the board receiving a new
   event, THE Board_UI SHALL fetch the game's events with a seq greater than the board's last
   applied seq and fold them into the Board_Projection.
8. WHEN an event is committed for a live game, THE Board_Projection of every member board that is
   connected at the commit and stays connected SHALL include the event within the Delivery_Bound,
   whether the event arrives by Realtime or by the recheck. A board that
   connects or reconnects after the commit receives the event through the criterion 6 refetch.

### Requirement 24: Testing

**User Story:** As a developer, I want card behavior covered by automated tests, so that changes to
one card don't silently break another.

#### Acceptance Criteria

1. THE test suite SHALL include fast-check property tests for the Challenge_Gate, Effect activation
   and expiry boundaries, Geodesic_Distance radius and finish-distance comparisons, Next_Claim_Restriction
   consumption, Happy Hour bonus uniqueness, Party Crasher share transitions, Insurance share floors,
   Patient Investor counting, Power Hour overlap, and Scoring_Ledger sum determinism.
2. THE test suite SHALL include route tests for atomic success, write-free rejection, authorization of
   Challenge resolutions and Host overrides, and event-append rollback for every new mutation.
3. THE test suite SHALL include a test asserting that the Card_Text_Catalog matches
   `docs/card-text-oracle.md` for every card.
4. THE default `npm test` run SHALL remain hermetic and offline, with live database and Realtime checks
   limited to `npm run test:integration`.
5. THE Board_UI SHALL render the new toasts, prompts, and actions at the existing 320px and desktop
   viewport bands without clipping, operable by keyboard and touch.
6. THE live integration test under `npm run test:integration` SHALL assert that an event committed
   for a live game reaches the Target_Team member's Board_Projection within the Delivery_Bound,
   retrying the assertion up to 3 times before failing.
7. THE test suite SHALL include fast-check property tests for the Legal_Next_Bar guard (including
   Pioneer and Scenic Route stacking and the Fairest mirror check), Timer_Sweep exactly-once
   settlement across interleaved Settle_Nudge, Card_Behavior_Mutation, and Cron_Route calls, and
   Boundary_Toast at-most-once display across local timers, events, reloads, and game end.
