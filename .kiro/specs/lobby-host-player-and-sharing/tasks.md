# Implementation Plan: Lobby Host, Player, and Sharing

## Overview

This plan implements three client-only fixes to the existing Game Setup & Lobby surfaces in
TypeScript/TSX: (1) the host becomes a player after create, (2) the code-entry form is separated
from team selection via an exhaustive three-way render selection, and (3) the Join_Code and a
shareable link are surfaced with copy affordances. No server route, schema, or realtime path
changes.

The work is sequenced so shared leaf pieces (the Share_Link helper, the pure selection function,
and the presentational components) land before the lobby-page wiring that depends on them. Tests
follow the implementation they cover. Property tests exercise the four correctness properties from
the design; example/integration tests cover ordering, persistence, recovery, and copy affordances.

## Tasks

- [ ] 1. Add the pure Share_Link helper
  - [ ] 1.1 Implement `buildShareLink` in `lib/lobby/shareLink.ts`
    - Create `lib/lobby/shareLink.ts` exporting `buildShareLink(origin: string | null, gameId: string, code: string): { path: string; absolute: string | null }`
    - Build `path` as `/games/{gameId}/lobby?code={encodeURIComponent(code)}`
    - Return `absolute = origin === null ? null : \`${origin}${path}\``
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ]* 1.2 Write property test for `buildShareLink`
    - **Feature: lobby-host-player-and-sharing, Property 3: Share_Link round-trips to the same game and code**
    - Generate arbitrary `gameId`, valid `Join_Code`, and `origin` of `string | null`; assert an absolute link is produced only when origin is present, that parsing it recovers the same `gameId` path segment and `code` query param, and that a `null` origin yields `absolute === null` with the code still representable
    - fast-check, ≥100 iterations
    - **Validates: Requirements 5.2, 5.3, 5.4**

- [ ] 2. Extend `CreateGame.tsx` with a required Display_Name
  - [ ] 2.1 Rename `BarDesignation` to `CreateSubmission` and add the Display_Name field
    - Rename/extend the exported payload type to `CreateSubmission { startBarName; finishBarName; displayName }`
    - Add a required Display_Name input alongside Start_Bar and Finish_Bar
    - Fold `validateDisplayName` into the existing `attempted`-gated inline `validationError` memo (append the start/finish rules with a name rule)
    - On a valid submit, emit the trimmed `displayName` (`validateDisplayName(displayName).value`); keep the submit control from issuing a request while `validationError !== null`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 6.1_

  - [ ]* 2.2 Write property test for the create-gate
    - **Feature: lobby-host-player-and-sharing, Property 1: Create-gate validation parity**
    - Generate `(startBarName, finishBarName, displayName)` triples around whitespace/length boundaries; assert `onCreate` fires iff start is non-empty trimmed, finish is non-empty trimmed and differs from start, and `validateDisplayName(displayName).ok`; and that the emitted `displayName` equals `validateDisplayName(name).value` on accept
    - fast-check, ≥100 iterations
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 6.1**

  - [ ]* 2.3 Write example tests for the Display_Name field
    - Assert the surface renders a Display_Name input (R1.1) and shows the inline validation message on an invalid name (R1.3)
    - _Requirements: 1.1, 1.3_

- [ ] 3. Add the `HostJoinCompletion.tsx` name-only completion surface
  - [ ] 3.1 Implement `components/lobby/HostJoinCompletion.tsx`
    - Create a presentational component with `HostJoinCompletionProps { onComplete(displayName): void | Promise<void>; submitting?; error? }`
    - Collect only a Display_Name (no code input), reusing `validateDisplayName` for inline feedback exactly like `JoinGame`
    - Call `onComplete` with the trimmed, valid display name; block submission on invalid name
    - _Requirements: 3.2, 3.3, 4.3_

  - [ ]* 3.2 Write example tests for `HostJoinCompletion`
    - Assert it renders no code input, shows inline feedback on an invalid name, and calls `onComplete` with the trimmed name on valid submit
    - _Requirements: 3.2, 3.3, 4.3_

- [ ] 4. Extract the pure lobby-entry selection function
  - [ ] 4.1 Implement a pure `selectLobbyEntry` helper
    - Add a pure function (co-located with the lobby page, e.g. `app/games/[gameId]/lobby/selectLobbyEntry.ts`) mapping `(isAdmin, hasJoined)` to one of `'team' | 'host-complete' | 'join'`
    - Rule: `hasJoined` → `'team'`; else `isAdmin` → `'host-complete'`; else `'join'`
    - _Requirements: 3.2, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 4.2 Write property test for the selection function
    - **Feature: lobby-host-player-and-sharing, Property 2: Exhaustive, mutually exclusive lobby-entry selection**
    - Generate `(isAdmin, hasJoined)` booleans; assert the function returns exactly one surface per the mapping and that the other two are never selected
    - fast-check, ≥100 iterations
    - **Validates: Requirements 3.2, 4.1, 4.2, 4.3, 4.4**

- [ ] 5. Add Share_Link + copy affordances to `LobbyRoster.tsx`
  - [ ] 5.1 Add `gameId` prop and the `ShareControls` region
    - Add `gameId: string` to `LobbyRosterProps`
    - Keep the existing monospace Join_Code text visible at all times (R5.1, R5.7)
    - Build the Share_Link via `buildShareLink(origin, gameId, joinCode)` using the browser origin at render time; render a copy-code button and, when `absolute` is present, the link plus a copy-link button; omit the absolute link and its control under SSR/null origin (R5.4)
    - Implement a client-only `copyToClipboard(text)` that uses `navigator.clipboard` with a graceful legacy fallback that never throws; show a transient "Copied" confirmation (`useState` + `setTimeout`) that never removes the code text
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 5.2 Write example tests for the roster copy affordances
    - With a clipboard spy: assert copy-code copies the raw Join_Code (R5.5) and copy-link copies the built link (R5.6); assert the code text survives either click (R5.7); in jsdom the link begins with `window.location.origin` (R5.3); an SSR/null-origin render omits the link without throwing (R5.4); assert the Join_Code text renders (R5.1)
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Wire the lobby page orchestration and render selection
  - [ ] 7.1 Update the `CreateGame` import and extend `handleCreate` to create → bars → join
    - Change the import in `app/games/[gameId]/lobby/page.tsx` from `BarDesignation` to `CreateSubmission` and update both `onCreate` handler signatures
    - Extend `handleCreate` to run create → bars → join on the same `x-bbb-session-id` header: after create success write `bbb:admin`, then POST bars, then POST join with the returned `joinCode` normalized via `lib/lobby/joinCode` and the trimmed `displayName`; on join success write `bbb:player` and call `setMyPlayerId`; navigate to the lobby once a `gameId` exists
    - Never issue a second `POST /api/games` when a later step fails; leave `bbb:player` unset on join failure
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 6.2, 6.3, 6.4_

  - [ ] 7.2 Add `handleHostComplete` and the three-way render selection, thread `gameId` into the roster
    - Add `handleHostComplete(displayName)` that joins using `view.joinCode` (guard against a null code by setting `formError` and issuing no request), writing `bbb:player` and setting `myPlayerId` on success
    - Replace the binary `!hasJoined ? JoinGame : TeamSelection` with the exhaustive three-way selection driven by `selectLobbyEntry(isAdmin, hasJoined)`: `hasJoined` → `TeamSelection`; else `isAdmin` → `HostJoinCompletion`; else `JoinGame`
    - Thread `gameId` into `LobbyRoster`
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 5.5_

  - [ ]* 7.3 Write property test for submitted Join_Code normalization parity
    - **Feature: lobby-host-player-and-sharing, Property 4: Submitted Join_Code normalization parity**
    - Generate arbitrary raw submitted Join_Code strings; assert a join request is issued only when `isValidSubmittedCode(code)` holds and that the code carried in the request equals `normalizeSubmittedCode(code)`
    - fast-check, ≥100 iterations
    - **Validates: Requirements 6.2**

  - [ ]* 7.4 Write example/integration tests for the orchestration
    - With mocked `postJson`/`fetch`, clipboard, and storage spies: assert create→bars→join ordering and that the join body carries the normalized code + trimmed name on the same `x-bbb-session-id` header (R2.1, R2.2, R6.3); a successful join writes `bbb:player` and sets `myPlayerId` (R2.3); host-completion does the same (R3.3); a join failure after create issues exactly one `POST /api/games`, still navigates, writes `bbb:admin`, and leaves `bbb:player` absent (R3.1)
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.3, 6.3_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirements for traceability.
- Property tests each carry a `Feature: lobby-host-player-and-sharing, Property N` tag and run
  ≥100 fast-check iterations.
- The feature is client-only: no files under `app/api`, no schema, and no realtime path change.
- Server idempotency (R2.4, R3.4) and the "no new route" constraint (R2.5, R6.4) are held by scope
  and the existing join-route property tests, not by new tasks here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "3.2", "4.2", "5.1"] },
    { "id": 2, "tasks": ["5.2", "7.1"] },
    { "id": 3, "tasks": ["7.2"] },
    { "id": 4, "tasks": ["7.3", "7.4"] }
  ]
}
```
