# Requirements Document

## Introduction

This feature delivers **App shell, navigation & entry points** (ROADMAP U0.1) for the
Beltline Bar Brawl web app. It is the UI skeleton every later feature plugs into. Today the
`game-setup-lobby` spec built the lobby pages and the six server routes, but the app has no
real landing page and no way for a player who only has a code to reach the right game — the
lobby is reachable only by typing a URL by hand. The foundation landing page (`app/page.tsx`)
is still the "baseline is running" splash.

This feature covers four cohesive slices:

- **App shell:** an app-wide layout/navigation shell rendered on every page — a small
  persistent header with BBB branding (logo, colors, tagline) that links back to the landing
  page — replacing the bare `app/layout.tsx` body wrapper.
- **Landing page:** a branded, mobile-first landing page (replacing the foundation splash)
  offering exactly two entry points: **Host a game** and **Join a game**.
- **Host entry:** a control that navigates to the existing create-game surface at
  `/games/new/lobby`.
- **Join entry (two paths):** (1) a **share link** carrying the game id
  (`/games/{gameId}/lobby`) that opens the lobby with the join code pre-filled, and (2) a
  **type-a-code** box on the landing page. Because a typed code is not a game id, this feature
  owns a new **code → gameId resolution** server route that maps a submitted Join_Code to the
  game it belongs to so the player can be routed to that game's lobby.

**Reuse.** This feature reuses the existing `lib/lobby` code validators
(`isValidSubmittedCode`, `normalizeSubmittedCode`), the session-based identity model
(`x-bbb-session-id`), and the existing lobby/join components (`JoinGame.tsx` already accepts
`initialJoinCode`). The stack is locked: Next.js App Router + TypeScript, Vercel + Supabase,
Vitest + fast-check, mobile-first.

**Security posture (this pass).** The resolution route is intentionally minimal: it performs
input-shape validation and returns a **uniform not-found result** that does not distinguish a
malformed code, a well-formed code that matches no game, or a code for an `ended` game — so a
caller cannot tell a hit from a miss beyond a successful resolution. Rate limiting is
explicitly out of scope for this pass and deferred. The route reads only the mapping needed to
resolve a code to a game id and leaks no other game data.

**Scope boundaries.** This feature does not change the six lobby routes or the join flow
itself (`POST /api/games/{gameId}/join`); it only routes the player to the correct lobby with
the code pre-filled, where the existing join flow takes over. Lobby experience polish
(error-state refinement, share-the-code affordance inside the lobby, the `live` handoff) is
owned by U1.1 and out of scope here. Rate limiting and any heavier enumeration hardening on the
resolution route are deferred. Full branding polish across every screen is owned by F4.3/U4.1;
this feature applies only the shell-level branding described above.

## Glossary

- **App_Shell:** The app-wide layout that wraps every page, rendering the persistent
  Header_Nav and the page content. Implemented as the Next.js App Router root layout.
- **Header_Nav:** The small persistent header shown on every page, carrying BBB branding (the
  logo, brand colors, and tagline) and a link to the Landing_Page.
- **Landing_Page:** The mobile-first home page at the application root path (`/`), presenting
  the Host_Entry and Join_Entry entry points and BBB branding.
- **Host_Entry:** The Landing_Page control that navigates a prospective Admin to the
  create-game surface at `/games/new/lobby`.
- **Join_Entry:** The Landing_Page area where a Player submits a Join_Code to reach a Game's
  lobby.
- **Join_Code:** The short, shareable alphanumeric code recorded on `games.join_code` that a
  Player uses to locate a Game. A submitted code is 6–12 alphanumeric characters after
  normalization (trim + uppercase), matching the existing `lib/lobby` validators.
- **Share_Link:** A URL of the form `/games/{gameId}/lobby` that carries a Game's id and, when
  opened, prefills the Game's Join_Code in the lobby's join form.
- **Lobby_Page:** The existing lobby page at `/games/{gameId}/lobby` (and the create surface at
  `/games/new/lobby`) built by the `game-setup-lobby` feature.
- **Resolution_Service:** The server-side component behind the code → gameId resolution route
  that maps a submitted Join_Code to the id of the non-`ended` Game that owns it.
- **Game:** A single BBB match, a row in the `games` table with a `lifecycle` of `lobby`,
  `live`, or `ended`.
- **Session:** The per-device, session-based identity of an Admin or Player, carried in the
  `x-bbb-session-id` header, consistent with the foundation Identity_Model. No account is
  required.

## Requirements

### Requirement 1: App shell and persistent header

**User Story:** As a player, I want a consistent branded header on every screen, so that I always know I am in the Beltline Bar Brawl app and can return home.

#### Acceptance Criteria

1. THE App_Shell SHALL render the Header_Nav on every page of the application.
2. THE Header_Nav SHALL display the BBB logo sourced from the project logo asset (`v0/BBB_logo.PNG`).
3. THE Header_Nav SHALL display the BBB tagline text.
4. WHEN a user activates the Header_Nav brand link, THE App_Shell SHALL navigate to the Landing_Page at `/`.
5. THE App_Shell SHALL render the current page content below the Header_Nav.
6. THE Header_Nav SHALL apply the BBB brand colors to its background and text.

### Requirement 2: Branded landing page

**User Story:** As a new visitor, I want a clear landing page with two obvious choices, so that I can either host a game or join one.

#### Acceptance Criteria

1. WHEN a user requests the application root path `/`, THE Landing_Page SHALL render the Host_Entry control and the Join_Entry area.
2. THE Landing_Page SHALL display the BBB logo, tagline, and brand colors.
3. WHEN a user requests the application root path `/`, THE Landing_Page SHALL return an HTTP 200 response.
4. THE Landing_Page SHALL replace the foundation "baseline is running" splash content.

### Requirement 3: Host entry point

**User Story:** As a host, I want a host button on the landing page, so that I can reach the create-game screen without typing a URL.

#### Acceptance Criteria

1. THE Landing_Page SHALL display the Host_Entry control labeled to indicate hosting a game.
2. WHEN a user activates the Host_Entry control, THE Landing_Page SHALL navigate to the create-game surface at `/games/new/lobby`.

### Requirement 4: Join-by-code entry point

**User Story:** As a player with a join code, I want to type my code on the landing page, so that I can reach the right game's lobby.

#### Acceptance Criteria

1. THE Join_Entry SHALL display a text input for a Join_Code and a submit control.
2. WHEN a user submits a Join_Code whose normalized value is not 6–12 alphanumeric characters, THE Join_Entry SHALL display an invalid-code message and SHALL NOT issue a resolution request.
3. WHEN a user submits a Join_Code whose normalized value is 6–12 alphanumeric characters, THE Join_Entry SHALL send the normalized Join_Code to the Resolution_Service.
4. WHEN the Resolution_Service returns a matching game id, THE Join_Entry SHALL navigate to `/games/{gameId}/lobby` with the submitted Join_Code prefilled.
5. IF the Resolution_Service returns a not-found result, THEN THE Join_Entry SHALL display a code-not-recognized message.
6. WHILE a resolution request is in flight, THE Join_Entry SHALL disable the submit control.

### Requirement 5: Share-link join entry

**User Story:** As a player who received a share link, I want the link to open the lobby with the code already filled in, so that I can join without typing the code.

#### Acceptance Criteria

1. WHEN a user opens a Share_Link at `/games/{gameId}/lobby`, THE Lobby_Page SHALL load the lobby for the Game identified by `gameId`.
2. WHEN a Share_Link supplies the Game's Join_Code, THE Lobby_Page SHALL prefill the join form's Join_Code field with the supplied Join_Code.

### Requirement 6: Code → gameId resolution route

**User Story:** As a player who only has a code, I want the app to find my game from that code, so that I can be routed to the correct lobby.

#### Acceptance Criteria

1. WHEN the Resolution_Service receives a request whose submitted Join_Code normalizes to 6–12 alphanumeric characters and matches exactly one non-`ended` Game, THE Resolution_Service SHALL return that Game's id.
2. IF the Resolution_Service receives a request whose submitted Join_Code does not normalize to 6–12 alphanumeric characters, THEN THE Resolution_Service SHALL return a not-found result.
3. IF the Resolution_Service receives a well-formed Join_Code that matches no non-`ended` Game, THEN THE Resolution_Service SHALL return a not-found result.
4. THE Resolution_Service SHALL return the same response shape and HTTP status for every not-found result, so that a malformed code, an unmatched code, and a code for an `ended` Game are indistinguishable to the caller.
5. THE Resolution_Service SHALL exclude the Join_Code, Game lifecycle, and any Game field other than the resolved Game id from its response.
6. THE Resolution_Service SHALL normalize the submitted Join_Code by trimming and uppercasing it before matching, consistent with the existing `lib/lobby` validators.

### Requirement 7: Mobile-first shell and entry points

**User Story:** As a player using a phone while walking the Beltline, I want the shell and landing page to fit my screen, so that I can use the app one-handed without horizontal scrolling.

#### Acceptance Criteria

1. WHILE rendered on a viewport between 320 and 430 CSS pixels wide, THE Landing_Page SHALL fit its content without horizontal scrolling.
2. WHILE rendered on a viewport between 320 and 430 CSS pixels wide, THE Header_Nav SHALL fit its content without horizontal scrolling.
3. THE Join_Entry submit control and Host_Entry control SHALL each present a touch target of at least 44 by 44 CSS pixels.
