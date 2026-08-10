## Purpose
TBD: Define the adapter contract for Pi session lifecycle management.

## Requirements

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

### Requirement: Use settled state as the turn boundary

The adapter SHALL treat `agent_settled` as the boundary at which Pi reports no
automatic continuation remains. It MUST NOT complete request work solely on
`agent_end`. The fixture demonstrates this boundary with a scripted retry;
compaction and automatic queued-continuation paths are untested and are not
guarantees of this spike.

#### Scenario: Low-level run ends before scripted retry settles

- **WHEN** Pi emits `agent_end` while a scripted retry remains
- **THEN** the adapter observes that the context is not idle and leaves request
  state unresolved

Compaction and automatic queued-continuation paths are not exercised by this
fixture and remain untested.

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

### Requirement: Use Pi native delivery modes for correlated messages
The adapter SHALL use a triggered custom message for inbound work when Pi is idle, `steer` for inbound work while Pi is busy, and `followUp` for received terminal outbound results while Pi is busy. It SHALL NOT implement a private wait-for-idle polling loop.

#### Scenario: Inbound work arrives while Pi is busy
- **WHEN** an admitted inbound router task is handed to a busy Pi session
- **THEN** the adapter queues the actionable custom message with `deliverAs: "steer"`

#### Scenario: Outbound result arrives while Pi is busy
- **WHEN** an outbound router task reaches a terminal state during a busy Pi session
- **THEN** the adapter queues the correlated result with `deliverAs: "followUp"`

### Requirement: Lifecycle events SHALL NOT infer Pi-to-Pi replies
`agent_end` and `agent_settled` SHALL NOT complete, fail, reject, or otherwise terminalize a Pi-to-Pi router task from assistant text, transcript order, or session state. `agent_settled` MAY update presentation or remind the model that explicit inbound requests remain unresolved.

#### Scenario: Assistant response ends without a reply tool call
- **WHEN** Pi emits `agent_end` or `agent_settled` after an assistant response and no `p2p_reply` call occurred
- **THEN** an active inbound router request remains nonterminal

### Requirement: Cancellation SHALL remain task-scoped at the Pi boundary
When the router cancels or expires a task, the adapter SHALL suppress undelivered work or mark already-delivered work non-actionable. It SHALL rely on router terminal-state checks to reject later replies and SHALL NOT invoke global `ctx.abort()` solely because one peer task was cancelled.

#### Scenario: A delivered request is later cancelled
- **WHEN** a Pi session receives an inbound request and its router task is subsequently cancelled
- **THEN** a later `p2p_reply` for that request fails through router state checks while unrelated Pi work continues

### Requirement: Runtime shutdown and replacement SHALL be generation-safe and idempotent
Shutdown SHALL stop exposing the outgoing runtime, fence its Pi delivery, close its router, stop/remove its exact Agent Card lease, close its owned transport endpoint, and release identity/resources in a deterministic owner-safe order. Repeated shutdown calls SHALL be safe, and an old runtime SHALL not remove a replacement card, close a replacement endpoint, or deliver work into a replacement Pi session.

#### Scenario: Reload replaces runtime resources
- **WHEN** Pi reloads a logical session
- **THEN** the replacement retains the logical session ID but uses a new runtime ID, endpoint, router, adapter, generation, and Agent Card

#### Scenario: Old shutdown races a replacement
- **WHEN** an outgoing runtime shutdown runs after a replacement has started
- **THEN** it removes or closes at most its own card and endpoint and leaves the replacement runtime available
