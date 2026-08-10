## MODIFIED Requirements

### Requirement: Scope session resources to lifecycle boundaries
The Pi adapter SHALL create session-scoped resources only after `session_start` and SHALL release those resources during `session_shutdown`. Loading or reloading the extension factory alone MUST NOT allocate sockets, timers, watchers, or child processes. A production runtime SHALL own exactly one transport server, Agent Card registry, router, adapter, and immutable generation. A replacement runtime SHALL start with a fresh live router-task scope; body-free Pi audit or custom-message metadata from reload, new, resume, fork, or clone SHALL NOT restore task ownership or be fed into a fresh `MessageRouter`.

#### Scenario: Extension factory load is side-effect free
- **WHEN** Pi evaluates the extension factory before a session starts
- **THEN** no session-scoped background resource is allocated

#### Scenario: Session startup creates resources
- **WHEN** Pi emits `session_start`
- **THEN** the adapter creates one ready production composition owned by that session runtime

#### Scenario: Session shutdown releases resources
- **WHEN** Pi emits `session_shutdown` for reload, replacement, or quit
- **THEN** the adapter releases only resources owned by the outgoing runtime

## ADDED Requirements

### Requirement: Runtime shutdown and replacement SHALL be generation-safe and idempotent
Shutdown SHALL stop exposing the outgoing runtime, fence its Pi delivery, close its router, stop/remove its exact Agent Card lease, close its owned transport endpoint, and release identity/resources in a deterministic owner-safe order. Repeated shutdown calls SHALL be safe, and an old runtime SHALL not remove a replacement card, close a replacement endpoint, or deliver work into a replacement Pi session.

#### Scenario: Reload replaces runtime resources
- **WHEN** Pi reloads a logical session
- **THEN** the replacement retains the logical session ID but uses a new runtime ID, endpoint, router, adapter, generation, and Agent Card

#### Scenario: Old shutdown races a replacement
- **WHEN** an outgoing runtime shutdown runs after a replacement has started
- **THEN** it removes or closes at most its own card and endpoint and leaves the replacement runtime available
