## ADDED Requirements

### Requirement: Scope session resources to lifecycle boundaries

The Pi adapter SHALL create session-scoped resources only after `session_start`
and SHALL release those resources during `session_shutdown`. Loading or
reloading the extension factory alone MUST NOT allocate sockets, timers,
watchers, or child processes.

#### Scenario: Extension factory load is side-effect free

- **WHEN** Pi evaluates the extension factory before a session starts
- **THEN** no session-scoped background resource is allocated

#### Scenario: Session startup creates resources

- **WHEN** Pi emits `session_start`
- **THEN** the adapter creates resources owned by that session runtime

#### Scenario: Session shutdown releases resources

- **WHEN** Pi emits `session_shutdown` for reload, replacement, or quit
- **THEN** the adapter releases only resources owned by the outgoing runtime

### Requirement: Use settled state as the turn boundary

The adapter SHALL treat `agent_settled` as the boundary at which a turn has no
automatic retry, compaction, or queued continuation remaining. It MUST NOT
complete request work solely on `agent_end`.

#### Scenario: Low-level run ends before settlement

- **WHEN** Pi emits `agent_end` while a retry, compaction, or queued continuation
  remains
- **THEN** the adapter observes that the context is not idle and leaves request
  state unresolved

#### Scenario: Agent settles

- **WHEN** Pi emits `agent_settled`
- **THEN** the adapter observes an idle context and may perform settlement-time
  bookkeeping for work explicitly associated with that request

### Requirement: Preserve lifecycle ordering across reload and replacement

The adapter SHALL handle the outgoing session before binding the replacement
session. A replacement start event MUST expose the previous session file, and a
replacement shutdown event MUST expose the target session file when available.

#### Scenario: Reload preserves the session identity

- **WHEN** Pi reloads extensions
- **THEN** `session_shutdown(reason: "reload")` occurs before
  `session_start(reason: "reload")` and the session ID/file remain unchanged

#### Scenario: New, resume, fork, or clone replaces a session

- **WHEN** Pi performs `/new`, `/resume`, `/fork`, or clone
- **THEN** the old runtime receives `session_shutdown` before the new runtime
  receives `session_start`, the new session has its own runtime binding, and
  outgoing in-memory delivery queues are not copied into the destination

### Requirement: Synchronize the session display name

The adapter SHALL read `pi.getSessionName()` during every `session_start` and
SHALL update its published identity on `session_info_changed`.

#### Scenario: Named session is loaded without a rename event

- **WHEN** a named session starts through startup, reload, resume, fork, or clone
  and no `session_info_changed` event is emitted
- **THEN** the adapter publishes the name read from `pi.getSessionName()`

#### Scenario: Session is renamed while running

- **WHEN** Pi emits `session_info_changed` with a new or cleared name
- **THEN** the adapter updates its published identity to that event value
