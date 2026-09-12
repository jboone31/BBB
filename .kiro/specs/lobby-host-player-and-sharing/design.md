# Design Document

## Overview

This feature refines the existing **Game Setup & Lobby** client with three tightly scoped,
**client-only** fixes. It touches four surfaces — `components/lobby/CreateGame.tsx`,
`components/lobby/JoinGame.tsx`, the lobby roster (`components/lobby/LobbyRoster.tsx`), and the
lobby page (`app/games/[gameId]/lobby/page.tsx`) — and changes **no server route, no schema, and
no realtime path**. It reuses the established session-based Identity_Model (`x-bbb-session-id`
header), the append-only `game_events` log, the existing `lib/lobby` validators
(`validateDisplayName`, `joinCode` normalize/validate), and the idempotent join route
(`POST /api/games/{gameId}/join`, which returns `{ applied, seq, playerId, created }`).

The three fixes:

- **Fix 1 — Host becomes a Player (client-side).** `CreateGame` gains a required Display_Name
  field. After the create request succeeds and returns `{ gameId, joinCode }`, the Lobby_Client
  immediately issues a join to the existing Join_Service using that `joinCode` and the trimmed
  Display_Name, on the **same** session header. The idempotent `(game_id, session_id)` join makes
  this safe to repeat.
- **Fix 2 — Separate "join a game" from "join a team".** The code-entry `Join_Game_Form` renders
  only for a visitor with **no** Player_Fact. Anyone with a Player_Fact sees the `Team_Pipeline`.
  A three-way selection replaces today's two-way `!hasJoined ? JoinGame : TeamSelection`, adding a
  host-completion surface for the `(isAdmin, !hasJoined)` recovery case.
- **Fix 3 — Surface the Join_Code and a Share_Link with copy affordances.** The roster shows the
  Join_Code as text (unchanged) plus copy controls for the raw code and for a Share_Link
  (`{origin}/games/{gameId}/lobby?code={code}`), built from the browser origin at render time and
  degrading gracefully under SSR.

### Design principles

- **No server changes.** Every behavior is achieved by re-sequencing existing POSTs and by
  presentational changes. This is a hard scope boundary (R2.5, R6.4).
- **Validator parity.** Client accept/reject decisions reuse the same pure validators the server
  enforces, so client feedback never diverges from server enforcement (R6.1, R6.2).
- **Presentational components stay presentational.** `CreateGame`, `JoinGame`, and the roster own
  only their own input/UI state; the page owns session identity, per-game facts, routing, and the
  create→bars→join orchestration.

## Architecture

### Create-then-join flow (Fix 1 + Fix 3 recovery)

The Lobby_Client's `handleCreate` extends the existing `create → bars` sequence with a third
step, `join`, all on the same session header:

```
handleCreate(submission: CreateSubmission)
  1. POST /api/games                       -> { applied, gameId, joinCode }   (create)
  2. POST /api/games/{gameId}/bars         -> { applied }                     (designate bars)
  3. POST /api/games/{gameId}/join         -> { applied, playerId, created }  (host joins)
  writeLocal(bbb:admin:{gameId}) after step 1 success
  writeLocal(bbb:player:{gameId}) + setMyPlayerId after step 3 success
  router.push(/games/{gameId}/lobby)
```

**Ordering rationale.** `create` must precede `bars` and `join` because both need the returned
`gameId`, and `join` needs the returned `joinCode`. `bars` and `join` both depend only on the
create result; they are ordered `bars` then `join` so the Admin's bar designation is recorded
before the host is added as a Player (keeping the existing bar flow first and appending the new
join last, which minimizes divergence from today's code).

**Failure handling (R3.1 / R3.2).** Each step degrades independently, and the game is **never**
recreated:

| Step fails | Effect | Recovery |
| --- | --- | --- |
| `create` | No game exists; surface `formError`; stay on create surface. | Admin resubmits. |
| `bars` | Game exists; `bbb:admin` written; navigate to lobby anyway (existing behavior). Admin lands with the bar-designation surface still open (`!barsDesignated`). | Admin retries bars in the lobby. |
| `join` | Game exists; `bbb:admin` written; **no** Player_Fact. Navigate to lobby. Admin lands as a **not-yet-joined Admin**. | Admin completes join via the host-completion surface (below). |

Because `bbb:admin:{gameId}` is written immediately after step 1 and `bbb:player:{gameId}` only
after step 3, a failure at step 2 or 3 leaves the durable local state in exactly the
"created-but-not-joined Admin" shape the render selection keys on. Navigation to the lobby always
happens once a `gameId` exists, so the Admin never loses the game they created.

### Three-way lobby-entry render selection (Fix 2 + Fix 3 recovery)

Today the lobby page renders `!hasJoined ? JoinGame : TeamSelection`. This design replaces that
binary with an exhaustive three-way selection over the two durable local facts
`(isAdmin, hasJoined)`, evaluated only while the game is in the `lobby` phase:

| `isAdmin` | `hasJoined` | Rendered lobby-entry surface |
| --- | --- | --- |
| any | `true` | `TeamSelection` (Team_Pipeline) |
| `true` | `false` | **Host-completion** (name-only; code from `view.joinCode`) |
| `false` | `false` | `JoinGame` (code-entry Join_Game_Form) |

This satisfies R4.4 (exactly one of Join_Game_Form or Team_Pipeline for a visitor) by treating the
host-completion surface as a specialization of "not yet a Player": a non-admin visitor with no
Player row sees the code-entry `JoinGame`; an Admin with no Player row sees the host-completion
(name only, because the code is already known from `view.joinCode`); anyone with a Player row sees
`TeamSelection`. Exactly one of the three renders in the lobby phase, and `JoinGame` and
`TeamSelection` are never shown together.

**Host-completion vs. `JoinGame.initialJoinCode`.** `JoinGame` already accepts an
`initialJoinCode` that prefills the code field (from a Share_Link `?code=` or a folded
`view.joinCode`) — but it still renders a code **input**. The host-completion surface differs: the
Admin already owns the game and the code is authoritative in `view.joinCode`, so it needs **no code
entry at all**. It collects only the Display_Name and submits `{ joinCode: view.joinCode, displayName }`
to the same join route. Reusing `JoinGame` with the code prefilled would wrongly ask the host to
confirm a code they never need to type; a dedicated name-only surface (`HostJoinCompletion`) keeps
the two intents distinct (mirroring Fix 2's "join a game" vs "join a team" separation).

### Share_Link construction (Fix 3)

A pure helper builds the Share_Link from `(origin, gameId, code)`:

```
buildShareLink(origin | null, gameId, code):
  path  = /games/{gameId}/lobby?code={encodeURIComponent(code)}
  absolute = origin === null ? null : `${origin}${path}`
  return { path, absolute }
```

- **Client (R5.2/R5.3):** `origin = window.location.origin`, yielding an absolute, copyable link.
- **Server / SSR (R5.4):** `typeof window === 'undefined'` → `origin = null` → `absolute = null`.
  The roster still renders the Join_Code text and simply omits the absolute link rather than
  throwing. (The relative `path` is retained for potential display but the requirement only
  mandates the code render and the absolute link be omitted.)

This matches the app-shell-navigation Share_Link model (`/games/{gameId}/lobby?code={code}`) and
prefills the recipient's `JoinGame` via the existing `?code=` → `joinCodePrefill` path already in
the page.

## Components and Interfaces

### 1. `CreateGame.tsx` — add required Display_Name (R1, R6.1)

The exported submission type is renamed/extended from `BarDesignation` to `CreateSubmission` to
carry the name. The component adds a Display_Name input and folds `validateDisplayName` into its
existing `attempted`-gated inline validation, extending the existing start/finish rules.

```typescript
/** What the Admin submits when creating a Game (was: BarDesignation). */
export interface CreateSubmission {
  readonly startBarName: string;   // trimmed, non-empty
  readonly finishBarName: string;  // trimmed, non-empty, differs from start
  readonly displayName: string;    // trimmed, 1–40 chars (validateDisplayName)
}

export interface CreateGameProps {
  readonly onCreate: (submission: CreateSubmission) => void | Promise<void>;
  readonly submitting?: boolean;
  readonly error?: string | null;
}
```

Validation gate (extends the current `validationError` memo):

```typescript
const validationError = useMemo<string | null>(() => {
  if (trimmedStart.length === 0) return "Enter a start bar name.";
  if (trimmedFinish.length === 0) return "Enter a finish bar name.";
  if (trimmedStart.toLowerCase() === trimmedFinish.toLowerCase())
    return "The start and finish bars must be different.";
  if (!validateDisplayName(displayName).ok)
    return "Enter a display name (1–40 characters).";
  return null;
}, [trimmedStart, trimmedFinish, displayName]);
```

On a valid submit the emitted `CreateSubmission.displayName` is the **trimmed** value
(`validateDisplayName(displayName).value`), matching what the join route will re-validate (R1.5,
R6.1). The submit control issues no request while `validationError !== null` (R1.3, R1.4).

> Note: `BarDesignation` is used by name in `page.tsx` (`import CreateGame, { type BarDesignation }`).
> The rename to `CreateSubmission` updates that import and both `onCreate` handlers (the create-mode
> one and the in-lobby bars-only one). The in-lobby bars-only usage still submits only
> `startBarName`/`finishBarName` to the bars route; the extra `displayName` field is present in the
> submission type but is only consumed by `handleCreate`.

### 2. `HostJoinCompletion.tsx` — new name-only completion surface (R3.2, R3.3, R4.3)

A small presentational component (co-located under `components/lobby/`) for the not-yet-joined
Admin. It reuses `validateDisplayName` for inline feedback exactly like `JoinGame`, but has **no
code input** — the code is supplied by the page from `view.joinCode`.

```typescript
export interface HostJoinCompletionProps {
  /** Called with the trimmed, valid display name; the page attaches the code. */
  readonly onComplete: (displayName: string) => void | Promise<void>;
  readonly submitting?: boolean;
  readonly error?: string | null;
}
```

### 3. `JoinGame.tsx` — unchanged interface

`JoinGame` and its `JoinSubmission` type are unchanged. It continues to accept `initialJoinCode`
for the code-entry (visitor) path. The only behavioral change is *where it renders* (Fix 2), which
is owned by the page.

### 4. `LobbyRoster.tsx` — add Share_Link + copy affordances (R5)

The roster gains `gameId` (to build the link) and renders a small `ShareControls` region beneath
the existing Join_Code text. The existing monospace Join_Code text is retained (R5.1, R5.7).

```typescript
export interface LobbyRosterProps {
  readonly gameId: string;                       // NEW: needed to build the Share_Link
  readonly joinCode: string | null;
  readonly teams: readonly LobbyTeamView[];
  readonly players: readonly LobbyPlayerView[];
}
```

`ShareControls` (either inline in the roster or a tiny sibling component):

- Renders the raw Join_Code as text (kept visible at all times).
- A **Copy code** button → `copyToClipboard(joinCode)`.
- When an absolute Share_Link is available (client), renders it and a **Copy link** button →
  `copyToClipboard(shareLink.absolute)`.
- Under SSR (`shareLink.absolute === null`), renders the code text and omits the link controls
  (R5.4).
- Each copy control shows a transient "Copied" confirmation for a short interval (e.g. via a
  `useState<boolean>` + `setTimeout`) that never removes the code text.

Clipboard helper (client-only, graceful fallback):

```typescript
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy fallback
  }
  // Best-effort legacy fallback (execCommand) or no-op; never throws.
  return false;
}
```

The `gameId` prop must be threaded from the page: `<LobbyRoster gameId={gameId} joinCode={view.joinCode} ... />`.

### 5. `app/games/[gameId]/lobby/page.tsx` — orchestration + selection

**`handleCreate` (extended):**

```typescript
const handleCreate = useCallback(
  async (submission: CreateSubmission): Promise<void> => {
    setBusy(true); setFormError(null);
    try {
      const created = await postJson("/api/games", {});
      if (!created.applied) { setFormError(created.error); return; }
      const newGameId = String((created as { gameId?: unknown }).gameId ?? "");
      const joinCode  = String((created as { joinCode?: unknown }).joinCode ?? "");
      if (newGameId === "") { setFormError("create_failed"); return; }
      writeLocal(adminFlagKey(newGameId), sessionId ?? "");

      const bars = await postJson(`/api/games/${newGameId}/bars`, {
        startBarName: submission.startBarName,
        finishBarName: submission.finishBarName,
      });
      if (!bars.applied) setFormError(bars.error); // game kept; retry in lobby

      // Fix 1: host joins its own game via the existing idempotent join route.
      const joined = await postJson(`/api/games/${newGameId}/join`, {
        joinCode,
        displayName: submission.displayName,
      });
      if (joined.applied) {
        const playerId = String((joined as { playerId?: unknown }).playerId ?? "");
        if (playerId !== "") {
          writeLocal(playerIdKey(newGameId), playerId);
          setMyPlayerId(playerId); // note: only affects state if already on this game's page
        }
      } // else: leave Player_Fact unset → not-yet-joined Admin recovery path

      router.push(`/games/${newGameId}/lobby`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "create_failed");
    } finally { setBusy(false); }
  },
  [postJson, router, sessionId],
);
```

Because create mode runs on `/games/new/lobby` and then navigates to `/games/{newId}/lobby`, the
durable `bbb:admin` / `bbb:player` writes (not the in-memory `myPlayerId`) are what the destination
page reads on mount via its lazy initializers. Writing both facts before `router.push` ensures the
destination renders the correct surface: `TeamSelection` when the host-join succeeded, or the
host-completion surface when it did not.

**Host-completion handler (new):** reuses the existing join POST but sources the code from the
folded view:

```typescript
const handleHostComplete = useCallback(
  async (displayName: string): Promise<void> => {
    if (view.joinCode === null) { setFormError("join_failed"); return; }
    setBusy(true); setFormError(null);
    try {
      const res = await postJson(`/api/games/${gameId}/join`, {
        joinCode: view.joinCode,
        displayName,
      });
      if (!res.applied) { setFormError(res.error); return; }
      const playerId = String((res as { playerId?: unknown }).playerId ?? "");
      if (playerId !== "") {
        writeLocal(playerIdKey(gameId), playerId);
        setMyPlayerId(playerId);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "join_failed");
    } finally { setBusy(false); }
  },
  [postJson, gameId, view.joinCode],
);
```

**Render selection (replaces the current `!hasJoined ? JoinGame : TeamSelection`):**

```tsx
{inLobby ? (
  <>
    {isAdmin && !barsDesignated ? (/* bars designation surface, unchanged */) : null}

    {hasJoined ? (
      <TeamSelection /* ...current props... */ />
    ) : isAdmin ? (
      <HostJoinCompletion
        onComplete={handleHostComplete}
        submitting={busy}
        error={formError}
      />
    ) : (
      <JoinGame
        onJoin={handleJoin}
        initialJoinCode={joinCodePrefill}
        submitting={busy}
        error={formError}
      />
    )}

    {isAdmin ? (<StartGame /* ...unchanged... */ />) : null}
  </>
) : null}
```

The roster call gains `gameId`:

```tsx
<LobbyRoster gameId={gameId} joinCode={view.joinCode} teams={view.teams} players={view.players} />
```

## Data Models

This feature introduces **no schema and no route changes**. All new state is client-only:

- **`CreateSubmission`** (replaces `BarDesignation`): `{ startBarName, finishBarName, displayName }`
  — the payload `CreateGame` emits to the page.
- **Durable per-game local facts (existing keys, unchanged shape):**
  - `bbb:admin:{gameId}` = the creating `sessionId` (drives `isAdmin`).
  - `bbb:player:{gameId}` = the joined `playerId` (drives `hasJoined` / `myPlayerId`).
- **Share_Link value object** (transient, per render): `{ path: string, absolute: string | null }`
  from `buildShareLink(origin, gameId, code)`.
- **Transient copy confirmation**: a per-control boolean UI flag; no persistence.

The server request/response contracts are used exactly as they already exist:
`POST /api/games` → `{ applied, seq, gameId, joinCode }`;
`POST /api/games/{gameId}/join` → `{ applied, seq, playerId, created }`.

## Error Handling

- **Join-after-create failure (R3.1/R3.2).** A non-`applied` (or thrown) join after a successful
  create sets `formError`, leaves `bbb:player` unset, and still navigates to the lobby. The Admin
  lands on the host-completion surface and retries. No second `POST /api/games` is ever issued;
  the idempotent join guarantees a retry produces no duplicate Player (R3.4).
- **Bars failure between create and join.** `formError` is surfaced; the flow still proceeds to
  navigate (game kept). The Admin sees the bar-designation surface (`!barsDesignated`) to retry.
- **Clipboard failure (R5.5/R5.6).** `copyToClipboard` catches any `navigator.clipboard` rejection
  and attempts a legacy fallback; it never throws and returns a boolean. A failed copy simply skips
  the transient "Copied" confirmation. The Join_Code text remains visible regardless (R5.7).
- **SSR origin unavailable (R5.4).** `buildShareLink(null, …)` returns `{ absolute: null }`; the
  roster renders the Join_Code and omits the absolute link and its copy control rather than
  throwing.
- **Missing `view.joinCode` on host-completion.** If the folded view has not yet resolved a code,
  the host-completion submit sets `formError` and issues no request (guards against sending an empty
  code to the join route).

## Testing Strategy

Vitest is the runner; fast-check drives property tests; React Testing Library renders components.
Both example-based and property-based tests are used per the dual-testing approach.

**Property tests** (fast-check, ≥100 iterations each; each tagged
`Feature: lobby-host-player-and-sharing, Property N: <text>`):

- **P1 — create-gate validation parity** (`CreateGame`): generate `(start, finish, name)` triples
  around the whitespace/length boundaries; assert `onCreate` fires iff all three client rules pass,
  and that the emitted `displayName` equals `validateDisplayName(name).value` on accept.
- **P2 — three-way render invariant** (lobby page render selection): generate `(isAdmin, hasJoined)`
  and assert exactly one of `TeamSelection` / `HostJoinCompletion` / `JoinGame` renders per the
  mapping, and the other two are absent. Test the pure selection function to keep it fast and
  deterministic.
- **P3 — Share_Link round-trip** (`buildShareLink`): generate arbitrary `gameId` and valid
  `Join_Code`, plus a `null | string` origin; assert that when `absolute` is present, parsing it
  recovers the same `gameId` (path segment) and `code` (query param), and that a `null` origin
  yields `absolute === null` with the code still representable.
- **P4 — Join_Code normalize/block parity** (join submission path): generate arbitrary submitted
  code strings; assert the value handed to the join POST equals `normalizeSubmittedCode(code)` and
  that submission is blocked whenever `!isValidSubmittedCode(code)`.

**Example / integration tests** (mocked `fetch`/`postJson`, clipboard and storage spies):

- Create→bars→join ordering and that the join body carries the normalized code + trimmed name, on
  the same `x-bbb-session-id` header (R2.1, R2.2, R6.3).
- Successful join writes `bbb:player` and sets `myPlayerId` (R2.3); host-completion does the same
  (R3.3).
- Join failure after create: exactly one `POST /api/games`, navigation still occurs, `bbb:admin`
  written, `bbb:player` absent (R3.1).
- `CreateGame` renders a Display_Name field (R1.1) and shows the inline message on invalid name
  (R1.3).
- Roster renders the Join_Code text (R5.1); clipboard spy shows the code copy copies the raw code
  (R5.5) and the link copy copies the built link (R5.6); the code text survives either click
  (R5.7); in jsdom the link begins with `window.location.origin` (R5.3); SSR render omits the link
  without throwing (R5.4).

Server idempotency (R2.4, R3.4) and the "no new route" constraint (R2.5, R6.4) are covered by the
existing join-route property tests and by scope (no files under `app/api` change).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — a formal statement about what the system should do. Properties bridge human-readable
specifications and machine-verifiable correctness guarantees.*

### Property 1: Create-gate validation parity

*For any* triple of raw inputs `(startBarName, finishBarName, displayName)`, the Create_Game_Surface
issues a create submission **if and only if** the start name is non-empty after trim, the finish
name is non-empty after trim and differs from the start name, **and** `validateDisplayName(displayName).ok`
is true; and whenever it does submit, the emitted `displayName` equals the trimmed value
`validateDisplayName(displayName).value`.

**Validates: Requirements 1.2, 1.3, 1.4, 1.5, 6.1**

### Property 2: Exhaustive, mutually exclusive lobby-entry selection

*For any* combination of the durable local facts `(isAdmin, hasJoined)` while a Game is in the
Lobby, the Lobby_Client renders **exactly one** lobby-entry surface, chosen as: `TeamSelection` when
`hasJoined` is true; the host-completion surface when `hasJoined` is false and `isAdmin` is true;
and the code-entry `JoinGame` when both are false — and the other two surfaces are never rendered.

**Validates: Requirements 3.2, 4.1, 4.2, 4.3, 4.4**

### Property 3: Share_Link round-trips to the same game and code

*For any* `gameId`, any valid `Join_Code`, and any origin value (a browser origin string or `null`
for SSR), `buildShareLink` produces an absolute link only when the origin is present, and any
absolute link it produces parses back to the same `gameId` in the path and the same `Join_Code` in
the `code` query parameter; when the origin is `null`, no absolute link is produced while the
Join_Code remains representable.

**Validates: Requirements 5.2, 5.3, 5.4**

### Property 4: Submitted Join_Code normalization parity

*For any* raw submitted Join_Code string, the Lobby_Client issues a join request **only when**
`isValidSubmittedCode(code)` holds, and the code carried in that request equals
`normalizeSubmittedCode(code)`.

**Validates: Requirements 6.2**
