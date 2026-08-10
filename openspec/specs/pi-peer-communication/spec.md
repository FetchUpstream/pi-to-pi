## Purpose

Define Pi's explicit, router-backed peer communication interface.

## Requirements

### Requirement: Pi SHALL expose explicit peer communication tools
The default extension SHALL register `p2p_peers`, `p2p_send`, `p2p_reply`, and `p2p_status` as communication-only tools through a stable runtime-aware dispatcher. The dispatcher SHALL use only the current self-composed production Pi adapter and SHALL return a normal tool error when no active runtime exists. It SHALL NOT expose `p2p_await` in v1 or introduce orchestration, role, worktree, or agent-spawning semantics in tool descriptions or prompt guidance.

#### Scenario: A peer answer is asynchronous
- **WHEN** `p2p_send` admits a request that expects a response
- **THEN** the tool returns after admission and does not wait for the terminal peer reply

### Requirement: Pi SHALL present and resolve live Agent Card peers safely
`p2p_peers` SHALL use the production `AgentCardRegistry` live peer boundary for the current exact room and SHALL return each peer's display and published names, full runtime identity, endpoint/address, available model/state/context/queue metadata, and protocol capabilities. `p2p_send` SHALL resolve a selected target only through that same production discovery boundary.

#### Scenario: Duplicate peer names are listed
- **WHEN** two valid live peers in the current room share a lookup name
- **THEN** `p2p_peers` returns both full runtime candidates and `p2p_send` does not route by that ambiguous name

#### Scenario: A full runtime target is selected
- **WHEN** `p2p_send` receives a uniquely found full runtime identity in the current room
- **THEN** it passes that identity to the router request API

### Requirement: Pi SHALL create outbound requests through the router
For a request, `p2p_send` SHALL construct typed content and optional expected-response metadata and call `MessageRouter.createRequest` before delivery. It SHALL report the request ID, selected target runtime, and admission outcome. If notifications are exposed, it SHALL send them through `MessageRouter.notify` and SHALL not create a task.

#### Scenario: Request admission succeeds
- **WHEN** the router returns an accepted or queued admission response
- **THEN** the tool reports that admission without awaiting `RouterRequestHandle.completion`

#### Scenario: Delivery is unreachable
- **WHEN** router delivery rejects or reports the target unreachable during admission
- **THEN** the tool returns a normal tool error containing the router failure and does not claim that a request was admitted

### Requirement: Pi SHALL deliver inbound tasks through an explicit executor
The Pi adapter SHALL implement the production `TaskExecutor` seam. For each admitted inbound request it SHALL preserve the exact request ID, sender identity, trace and parent metadata, expected-response metadata, and task state in Pi custom-message details. It SHALL return `void` after handing the request to Pi and SHALL NOT return assistant content or infer a terminal reply.

#### Scenario: Concurrent requests are delivered
- **WHEN** two inbound router requests are admitted for one Pi runtime
- **THEN** Pi receives independently correlated custom messages and either request can later be replied to by its exact request ID

#### Scenario: A task is cancelled before delivery
- **WHEN** the executor task signal is aborted before Pi receives the custom message
- **THEN** the adapter suppresses delivery and does not abort the global Pi context

### Requirement: Pi SHALL complete only explicit selected inbound tasks
`p2p_reply` SHALL require an exact request ID and inspect `MessageRouter.taskSnapshot` before acting. It SHALL reject missing, outbound, cancelled, expired, or terminal tasks. It SHALL use `completeTask`, `failTask`, or `rejectTask` for the selected inbound task and SHALL NOT construct a wire reply envelope.

#### Scenario: A valid explicit reply completes one task
- **WHEN** an active inbound request ID and valid reply content are supplied
- **THEN** the router terminalizes and delivers only that request

#### Scenario: A structured reply is invalid
- **WHEN** completed content violates the request's expected structured response
- **THEN** `p2p_reply` returns a normal tool error and the request remains active for correction

### Requirement: Pi SHALL inject terminal outbound results exactly once
The adapter SHALL observe each `RouterRequestHandle.completion` or equivalent production router task callback and inject one correlated custom message into the originating Pi session. The message SHALL identify the request ID and peer and include terminal completed content or failure, cancellation, or expiry information. The adapter SHALL prevent duplicate injection of a terminal snapshot.

#### Scenario: A peer completes while Pi is busy
- **WHEN** an outbound request reaches a terminal state while its originating Pi session is busy
- **THEN** the adapter injects the result as a `followUp` message rather than steering work

#### Scenario: Duplicate terminal observation occurs
- **WHEN** the adapter observes the same terminal request snapshot more than once
- **THEN** it injects only one Pi custom message for that request

### Requirement: Pi SHALL expose router task state without transcript inference
`p2p_status` SHALL use `MessageRouter.taskSnapshot` or its production task-store facade to report live direction/ownership, state, peer, expiry, cancellation status, and retained terminal result. Historical audit metadata MAY be shown separately and SHALL NOT be represented as a live router task.

#### Scenario: A historical record exists without a live task
- **WHEN** a session contains an audit entry for a previous runtime request ID and the current router has no snapshot
- **THEN** `p2p_status` does not report that record as an active task

### Requirement: Pi delivery SHALL be fenced to its originating runtime generation
The adapter and task executor SHALL capture the generation, session, and runtime that own inbound delivery and outbound completion callbacks. They SHALL deliver a terminal follow-up only when that exact generation remains active, and SHALL drop callbacks from replaced runtimes.

#### Scenario: Old completion resolves after replacement
- **WHEN** an old runtime's request completion resolves after reload, new, resume, fork, or clone creates a replacement runtime
- **THEN** no result custom message is injected into the replacement Pi session
