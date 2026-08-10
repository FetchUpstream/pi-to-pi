## MODIFIED Requirements

### Requirement: Scope session resources to lifecycle boundaries
The Pi adapter SHALL create session-scoped resources only after `session_start` and SHALL release those resources during `session_shutdown`. Loading or reloading the extension factory alone MUST NOT allocate sockets, timers, watchers, or child processes. A replacement runtime SHALL start with a fresh live router-task scope; body-free Pi audit or custom-message metadata from reload, new, resume, fork, or clone SHALL NOT restore task ownership or be fed into a fresh `MessageRouter`.

#### Scenario: Extension factory load is side-effect free
- **WHEN** Pi evaluates the extension factory before a session starts
- **THEN** no session-scoped background resource is allocated

#### Scenario: Session startup creates resources
- **WHEN** Pi emits `session_start`
- **THEN** the adapter creates resources owned by that session runtime

#### Scenario: Session shutdown releases resources
- **WHEN** Pi emits `session_shutdown` for reload, replacement, or quit
- **THEN** the adapter releases only resources owned by the outgoing runtime

#### Scenario: Reload does not restore live task ownership
- **WHEN** an extension reload creates a replacement runtime for the same Pi session
- **THEN** the replacement adapter has a fresh router task scope and does not recreate live tasks from persisted Pi metadata

#### Scenario: Fork or clone copies audit history
- **WHEN** a fork or clone copies Pi custom entries describing a non-terminal request
- **THEN** the destination runtime does not acquire the copied request and can act only on newly admitted router tasks

## ADDED Requirements

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
