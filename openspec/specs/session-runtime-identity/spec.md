# Session Runtime Identity

## Purpose

TBD — define stable logical session identity and ephemeral runtime identity.

## Requirements

### Requirement: Stable logical session identity
The P2P extension MUST use Pi's native session manager UUID as the logical session ID and MUST read it when handling `session_start`.

#### Scenario: Reload preserves logical session identity
- **WHEN** Pi reloads the extension for the current conversation
- **THEN** the replacement runtime reports the same session ID as the previous runtime

#### Scenario: Resume identifies the selected saved session
- **WHEN** Pi resumes an existing session file
- **THEN** the runtime reports the session UUID stored in that session file

#### Scenario: New and forked sessions receive distinct logical identities
- **WHEN** Pi starts a new session or creates a fork
- **THEN** the runtime reports the new session's UUID and does not reuse the previous session ID

### Requirement: Ephemeral runtime identity
The P2P extension MUST create a fresh UUID runtime ID for every started extension runtime and MUST NOT restore it from Pi session data.

#### Scenario: Runtime starts
- **WHEN** Pi emits `session_start`
- **THEN** the extension creates one fresh runtime ID for that runtime and uses it for registry ownership

#### Scenario: Runtime replacement cannot reuse identity
- **WHEN** an old runtime is replaced by reload, session replacement, process restart, or shutdown/startup
- **THEN** the replacement runtime has a different runtime ID even when the logical session ID is unchanged

### Requirement: Runtime address is authoritative
The full runtime UUID MUST be the machine-actionable peer target. Session IDs and display names MUST NOT be used as endpoint ownership or routing identities.

#### Scenario: Route to a peer
- **WHEN** a protocol operation targets a peer
- **THEN** the target identifies the peer runtime UUID and exact room

#### Scenario: Old runtime record remains
- **WHEN** an old runtime record is still present while a replacement runtime is active
- **THEN** an operation addressed to the old runtime cannot be routed to the replacement runtime

### Requirement: Lifecycle cleanup is idempotent
The extension MUST release resources for the current runtime on Pi's native `session_shutdown` event and MUST tolerate repeated shutdown handling.

#### Scenario: Normal shutdown
- **WHEN** Pi emits `session_shutdown` for a runtime
- **THEN** the extension closes that runtime's resources and removes only that runtime's registry record

#### Scenario: Repeated shutdown
- **WHEN** shutdown cleanup is invoked more than once
- **THEN** cleanup completes without removing another runtime's record or throwing because the current record is already absent
