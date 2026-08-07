## ADDED Requirements

### Requirement: Persist compact request metadata

The adapter SHALL persist task state as append-only `p2p.task` metadata entries
with an exact version-1, body-free schema containing:

- `version`, with value `1`;
- `requestId`, identifying the task;
- `sessionId`, the immutable origin session identity captured when the task is
  accepted;
- `ownerSessionId`, the current session identity that wrote the latest record;
- `runtimeId`, the runtime identity that wrote the latest record;
- `peerId`, the peer identity when known, otherwise `null`;
- `state`, one of `accepted`, `completed`, `failed`, `expired`, or `superseded`;
- `updatedAt`, an ISO timestamp;
- `expiresAt`, an ISO timestamp or `null`; and
- `reason`, which is `null` except on a `superseded` record, where it is
  required.

The initial accepted record sets `sessionId` and `ownerSessionId` to the
current session. Each transition preserves the immutable `sessionId`,
`peerId`, and `expiresAt`; `ownerSessionId` and `runtimeId` identify the
session and runtime that wrote that transition. For a `superseded` record, the
destination `ownerSessionId` is audit-only and does not grant live ownership or
completion authority. The adapter SHALL NOT duplicate
request or response bodies in task metadata.

#### Scenario: Accepted request is recorded

- **WHEN** request `request-a` is accepted
- **THEN** the session contains a body-free `p2p.task` record for `request-a`
  with `sessionId` and `ownerSessionId` equal to the current session identity,
  a runtime identity, any known `peerId`, and state `accepted`

#### Scenario: State transition is append-only

- **WHEN** request `request-a` completes, fails, expires, or is superseded
- **THEN** the adapter appends a new state record, preserves the immutable
  origin `sessionId`, and makes the latest record authoritative after folding
  records by `requestId`

### Requirement: Recover non-terminal tasks after reload

The adapter SHALL fold persisted task records during
`session_start(reason: "reload")` and SHALL recover only records whose latest
state is `accepted`, whose expiry has not passed, and whose `sessionId` and
`ownerSessionId` both equal the selected session identity. The adapter SHALL
not reopen terminal records.

#### Scenario: Pending task survives reload

- **WHEN** a session reloads with a latest `accepted` task record for
  `request-a` that has not expired and is owned by that session
- **THEN** the adapter reconstructs request state for `request-a` in the same
  session scope

#### Scenario: Terminal or expired task does not reopen

- **WHEN** a session reloads with a latest `completed`, `failed`, `expired`, or
  `superseded` record, or with an expired `accepted` record
- **THEN** the adapter does not recover that request as pending

### Requirement: Keep task ownership session-scoped

The adapter SHALL associate recovered task state with its immutable `sessionId`
and current `ownerSessionId` and SHALL NOT silently migrate pending work across
session creation or replacement. The lifecycle binding SHALL clear the active
in-memory task scope on `session_shutdown`, fold the selected branch on
`session_start`, and complete fork/clone supersession before destination
handling can complete an inherited task.

#### Scenario: New session starts clean

- **WHEN** `/new` replaces a session containing accepted task records
- **THEN** the old runtime is shut down before the new runtime starts, the new
  session starts with an empty task scope, and it does not complete or inherit
  the old session's requests

#### Scenario: Resume recovers only the selected session

- **WHEN** `/resume` switches to a persisted target session
- **THEN** the adapter recovers task records from the target session only and
  does not carry the outgoing session's in-memory task map into it

### Requirement: Supersede inherited fork and clone tasks

The adapter SHALL treat copied non-terminal task records in a forked or cloned
session as inherited history. Before the new session can complete such a task,
it SHALL append a `superseded` record with a reason identifying the session
replacement. The superseding record SHALL preserve the immutable `sessionId`,
`peerId`, and `expiresAt`, and SHALL set `ownerSessionId` and `runtimeId` to the
destination identities. Fork/clone replacement is superseded-only: it SHALL
not reopen copied work or create another non-terminal state for the inherited
request.

#### Scenario: Clone contains pending metadata

- **WHEN** clone copies a branch containing an unexpired `accepted` task record
- **THEN** the destination lifecycle appends a `superseded` record before
  destination delivery, the cloned session does not claim ownership of the
  request, and its latest task state is `superseded`

#### Scenario: Fork omits metadata before its branch point

- **WHEN** fork creates a branch before an accepted task's metadata entry
- **THEN** the forked session contains no recovered state for that task and has
  no record to supersede

## Fixture boundary

This contract is exercised by the in-process faux-provider fixture and its
isolated session files. It does not implement production task persistence,
transport or router behavior, cross-process failure handling, or crash
durability guarantees; those remain outside this spike's scope.
