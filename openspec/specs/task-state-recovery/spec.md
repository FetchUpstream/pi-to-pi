## Purpose
TBD: Define the adapter contract for persisted task-state recovery and ownership.

## Requirements

### Requirement: Persist compact request metadata

The adapter SHALL persist task state as append-only `p2p.task` metadata entries
with an exact version-1, body-free schema containing:

- `version`, with value `1`;
- `requestId`, identifying the task;
- `sessionId`, the immutable origin session identity captured when the task is
  accepted;
- `ownerSessionId`, the current session identity that wrote the latest record;
- `runtimeId`, an adapter-assigned opaque writer identity for the latest writer;
  the Pi SDK does not mint this value. In this fixture it is a non-empty,
  caller-supplied provenance label from the fixture option or transition call; the
  fixture does not derive or validate it against `AgentSessionRuntime`, enforce
  uniqueness, or authenticate the writer; actual runtime identity remains outside
  this spike;
- `peerId`, the peer identity when known, otherwise `null`;
- `state`, one of `accepted`, `completed`, `failed`, `expired`, or `superseded`;
- `updatedAt`, an ISO timestamp;
- `expiresAt`, an ISO timestamp or `null`; and
- `reason`, which is `null` except on a `superseded` record, where it is
  required.

The initial accepted record sets `sessionId` and `ownerSessionId` to the
current session. Each transition preserves the immutable `sessionId`, `peerId`,
and `expiresAt`; `ownerSessionId` records the session that wrote the transition.
In this fixture, `runtimeId` records a caller-supplied fixture option or transition
argument and is not derived from or validated against the bound runtime object.
For a `superseded` record, the destination `ownerSessionId` is audit-only and
does not grant live ownership or completion authority. The adapter SHALL NOT
duplicate request or response bodies in task metadata.

The fixture binds metadata operations to the exact runtime, session, and manager
objects. Callers supply the opaque `runtimeId` for each writer; a replacement
runtime uses a distinct ID for its supersession record, and a stale binding MUST
be rejected even when a `SessionManager` object is reused.

#### Scenario: Accepted request is recorded

- **WHEN** request `request-a` is accepted
- **THEN** the session contains a body-free `p2p.task` record for `request-a`
  with `sessionId` and `ownerSessionId` equal to the current session identity,
  a caller-supplied `runtimeId` provenance label, any known `peerId`, and state
  `accepted`

#### Scenario: State transition is append-only

- **WHEN** request `request-a` completes, fails, expires, or is superseded
- **THEN** the adapter appends a new state record, preserves the immutable
  origin `sessionId`, and makes the latest record authoritative after folding
  records by `requestId`

The fixture applies this transition matrix; expiry is evaluated at `now`, and a
`null` `expiresAt` means that an accepted record does not expire:

| Current latest state | Next state | Allowed condition | Result |
| --- | --- | --- | --- |
| no record | `accepted` | Initial append; `expiresAt` is an ISO timestamp or `null`; `reason` is `null` | Non-terminal |
| `accepted` | `completed` or `failed` | Current session owns the record and it is unexpired, including `expiresAt: null` | Terminal |
| `accepted` | `expired` | Current session owns the record and a non-null `expiresAt` is at or before `now` | Terminal |
| `accepted` | `superseded` | Lifecycle-authorized inherited fork/clone record is unexpired and has a non-empty reason | Terminal; destination ownership is audit-only |
| `accepted` | `accepted` | Never | Rejected |
| `completed`, `failed`, `expired`, or `superseded` | Any state | Never; terminal records have no outgoing transitions | Rejected |

An accepted record may be appended with an already-passed expiry, but recovery
excludes it and only the explicit `accepted` → `expired` transition is valid.
Every allowed transition appends a record, preserves `sessionId`, `peerId`, and
`expiresAt`, and does not move `updatedAt` backwards. `requestId` is folded only
within the selected session branch; this fixture does not establish process-global
request ID uniqueness.

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
handling can complete an inherited task. A `session_tree` event within the same
runtime re-folds the selected branch and replaces its in-memory recoverable
scope without changing the runtime/session binding. Direct calls to
`SessionManager.branch()` do not emit that event; a persisted clone helper given
only a file therefore uses the last persisted entry unless its caller supplies the
selected `sourceLeafId`.

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
`peerId`, and `expiresAt`, and SHALL set `ownerSessionId` to the destination
session and `runtimeId` to its caller-supplied fixture option. Fork/clone
replacement is superseded-only: it SHALL
not reopen copied work or create another non-terminal state for the inherited
request.

The fixture's persisted clone helper copies only the selected branch using
`createBranchedSession`; it does not use `SessionManager.forkFrom`, which copies
inactive JSONL branches. Because JSONL does not persist a live `session_tree` leaf,
callers must provide `sourceLeafId` when the selected leaf is not the file's last
entry.

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
durability guarantees; those remain outside this spike's scope. The fixture
also retains every append-only `p2p.task` entry without pruning terminal records
or bounding session-file history. This unbounded-retention limitation is measured
against the repository retention convention in `SPEC.md`; production retention
and garbage collection remain future work.
