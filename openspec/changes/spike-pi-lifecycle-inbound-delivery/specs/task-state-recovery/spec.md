## ADDED Requirements

### Requirement: Persist compact request metadata

The adapter SHALL persist task state as append-only `p2p.task` metadata entries
containing a version, request ID, originating session identity, runtime identity,
peer identity when known, state, update time, and expiry when applicable. Task
entries MUST NOT duplicate request or response bodies.

#### Scenario: Accepted request is recorded

- **WHEN** request `request-a` is accepted
- **THEN** the session contains a `p2p.task` record for `request-a` with origin
  session identity and a non-terminal accepted state

#### Scenario: State transition is append-only

- **WHEN** request `request-a` completes, fails, expires, or is superseded
- **THEN** the adapter appends a new state record and the latest record is the
  authoritative state after folding records by request ID

### Requirement: Recover non-terminal tasks after reload

The adapter SHALL fold persisted task records during
`session_start(reason: "reload")` and SHALL recover only requests whose latest
state is non-terminal and unexpired.

#### Scenario: Pending task survives reload

- **WHEN** a session reloads with a latest `accepted` task record for
  `request-a` that has not expired
- **THEN** the adapter reconstructs request state for `request-a` in the same
  session scope

#### Scenario: Terminal or expired task does not reopen

- **WHEN** a session reloads with a latest `completed`, `failed`,
  `expired`, or expired `accepted` record
- **THEN** the adapter does not recover that request as pending

### Requirement: Keep task ownership session-scoped

The adapter SHALL associate recovered task state with its originating session
identity and SHALL NOT silently migrate pending work across session creation or
replacement.

#### Scenario: New session starts clean

- **WHEN** `/new` replaces a session containing accepted task records
- **THEN** the new session starts with an empty task scope and does not complete
  the old session's requests

#### Scenario: Resume recovers only the selected session

- **WHEN** `/resume` switches to a persisted target session
- **THEN** the adapter recovers task records from the target session only and
  does not carry the outgoing session's in-memory task map into it

### Requirement: Supersede inherited fork and clone tasks

The adapter SHALL treat copied non-terminal task records in a forked or cloned
session as inherited history. Before the new session can complete such a task,
it SHALL append a `superseded` record with a reason identifying the session
replacement.

#### Scenario: Clone contains pending metadata

- **WHEN** clone copies a branch containing an accepted task record
- **THEN** the cloned session does not claim ownership of the request and its
  latest task state becomes `superseded`

#### Scenario: Fork omits metadata before its branch point

- **WHEN** fork creates a branch before an accepted task's metadata entry
- **THEN** the forked session contains no recovered state for that task
