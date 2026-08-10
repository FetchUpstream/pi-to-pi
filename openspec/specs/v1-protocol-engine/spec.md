## Purpose

Implement the transport-independent runtime engine for the Pi-to-Pi v1 protocol, including deterministic validation, task lifecycle management, routing, deduplication, bounded resources, and conformance seams. The existing `pi-to-pi-v1-protocol` specification remains authoritative for wire semantics.

## Requirements

### Requirement: Transport-independent v1 engine contracts

The protocol engine SHALL expose transport-independent contracts for the v1 envelope, the six supported operations, typed content, operation responses, task snapshots, protocol capabilities, and stable errors. The engine SHALL keep `operationId` and logical `requestId` distinct, and SHALL never infer task correlation from transcript order, Pi lifecycle events, or a global current-request value.

#### Scenario: Valid request and reply remain explicitly correlated

- **WHEN** a valid `message.request` uses its `operationId` as `requestId` and a later `message.reply` uses a new `operationId` targeting that request ID
- **THEN** the engine applies the reply only to the matching logical request and preserves trace and parent-operation metadata independently

#### Scenario: Malformed initial request correlation is rejected

- **WHEN** a task-bearing initial request contains different `operationId` and `requestId` values
- **THEN** the engine returns a `malformed` protocol error and does not admit a task

#### Scenario: Operation response is unambiguous

- **WHEN** an operation response is constructed or received
- **THEN** it echoes the operation ID and trace ID and contains exactly one of `result` or `error`

### Requirement: Deterministic envelope, content, and schema validation

The engine SHALL validate protocol version, operation, UUIDv4 identifiers, UTC `Z` timestamps, trace identifiers, required fields, request-ID relationships, typed content, and effective protocol limits deterministically. It SHALL reject an oversized serialized envelope before expensive parsing or validation. Expected structured responses SHALL use JSON content and a JSON Schema Draft 2020-12 validator supplied by an explicit runtime dependency; schema evaluation SHALL allow only embedded or local references, SHALL make no network requests, and SHALL treat `format` as annotation unless an explicitly supported assertion vocabulary is selected.

#### Scenario: Oversized envelope is rejected early

- **WHEN** a serialized operation exceeds the effective envelope limit
- **THEN** the engine returns `oversized` without performing full payload or schema validation

#### Scenario: Invalid expected schema prevents admission

- **WHEN** a request contains an oversized, malformed, unsupported, or remote-referencing expected-response schema
- **THEN** the engine rejects it with the applicable `oversized`, `malformed`, or `incompatible` error before task admission

#### Scenario: Structured reply validation is performed on both sides

- **WHEN** an admitted request has an expected schema and a completed reply is produced or received
- **THEN** the recipient validates the reply before delivery and the requester validates it again before terminalizing the task

#### Scenario: Invalid structured reply leaves work nonterminal

- **WHEN** a JSON reply does not satisfy the stored expected schema
- **THEN** the engine returns `invalid_reply` and leaves the active request eligible for a valid reply, failure, cancellation, or expiry

### Requirement: Protocol capability projection

The engine SHALL provide the protocol capability projection used by `peer.describe` independently from discovery Agent Card validation and its numeric schema version. The projection SHALL report exact supported wire versions, supported operation names, typed-content and structured-response support, cancellation and notification support, and effective envelope, control, schema, and queue limits.

#### Scenario: Peer description reports protocol capabilities

- **WHEN** a compatible peer handles `peer.describe`
- **THEN** it returns its discovery card together with a projection containing wire version `1.0` and effective limits, without creating a task

#### Scenario: Unsupported operation is not silently reinterpreted

- **WHEN** a peer receives an unavailable operation or unsupported major protocol version
- **THEN** it returns `incompatible` and does not admit a task

### Requirement: Task lifecycle and terminal immutability

The task store SHALL represent `created`, `accepted`, `queued`, `working`, `cancelling`, `completed`, `failed`, `rejected`, `cancelled`, and `expired`. It SHALL enforce only the transitions defined by the authoritative v1 specification, keep sender-local creation distinct from receiver admission, and make terminal snapshots immutable, including outcome, response correlation, content, and failure information.

#### Scenario: Admitted work follows legal states

- **WHEN** a valid request passes admission
- **THEN** the receiver records it as `accepted` or `queued` and transitions it to `working` before execution begins

#### Scenario: Illegal transition is rejected without mutation

- **WHEN** a task receives an operation that is not legal from its current state
- **THEN** the engine returns the applicable stable error and preserves the existing task snapshot

#### Scenario: First terminal transition wins

- **WHEN** completion, failure, cancellation, or expiry races for the same task
- **THEN** the first atomically committed terminal transition wins and later operations cannot mutate that terminal state

### Requirement: Absolute expiry and bounded task retention

The engine SHALL enforce the absolute `expiresAt` supplied by the sender. Normal requests SHALL default to ten minutes and SHALL not exceed one hour; control operations SHALL not exceed 30 seconds; replies SHALL use the original request deadline or an earlier deadline. Retries SHALL not extend deadlines. After admission, expiry enforcement SHALL use a monotonic timer. Active and deduplication state SHALL be bounded and terminal records SHALL be pruned no earlier than the required deadline-plus-grace retention window.

#### Scenario: Expired request is not admitted

- **WHEN** an operation arrives at or after its deadline
- **THEN** the engine returns `expired` and does not enqueue or execute it

#### Scenario: Queued work expires before execution

- **WHEN** a queued task reaches its absolute deadline before work starts
- **THEN** it transitions to `expired` and its executor is never invoked

#### Scenario: Retry cannot extend expiry

- **WHEN** an operation is retried with the same operation ID after its original deadline
- **THEN** the engine returns `expired` rather than admitting it with a new deadline

#### Scenario: Retention is eventually bounded

- **WHEN** terminal task and deduplication records pass their configured retention deadline
- **THEN** cleanup removes them without removing newer or active records

### Requirement: Cooperative cancellation and authorized status

The engine SHALL support idempotent `task.cancel` and `task.status` operations. Only the original requester or an authorized local task owner SHALL inspect or cancel a task. Queued cancellation SHALL remove runnable work and transition directly to `cancelled`; working cancellation SHALL transition to `cancelling` and signal only the matching executor. Unknown-task responses SHALL occur only after authorization checks, and late replies SHALL not mutate terminal state.

#### Scenario: Queued task is cancelled

- **WHEN** the authorized requester cancels a queued task
- **THEN** the engine removes it from runnable work, records `cancelled`, and returns the cancelled snapshot

#### Scenario: Working task receives scoped cancellation

- **WHEN** the authorized requester cancels a working task
- **THEN** only that task transitions to `cancelling` and only its executor receives the cancellation signal

#### Scenario: Unauthorized status does not disclose existence

- **WHEN** an unrelated runtime requests status for a task
- **THEN** the engine returns `unauthorized` without revealing whether the task exists or its current state

#### Scenario: Cancellation is idempotent after cancellation

- **WHEN** the same authorized cancellation is delivered again after the task is already cancelled
- **THEN** the engine returns the existing cancelled snapshot without another state transition

### Requirement: Retry-safe runtime-scoped deduplication

The engine SHALL deduplicate `message.request`, `message.notify`, `message.reply`, and `task.cancel` by `(senderRuntimeId, operationId)`. It SHALL compare a deterministic canonical fingerprint containing immutable operation fields, IDs, identities, room, timestamps, trace and parent fields, and payload while excluding binding credentials. It SHALL record the fingerprint and admission or delivery result before acknowledging execution, retain the record through the request deadline plus at least ten minutes, and scope the records to the current runtime.

#### Scenario: Identical admitted request is replayed

- **WHEN** an identical request retry arrives with the same sender runtime and operation ID
- **THEN** the engine replays the stored acknowledgement and does not create or execute a second task

#### Scenario: Conflicting operation reuse is rejected

- **WHEN** an operation ID is reused with a different immutable fingerprint
- **THEN** the engine returns non-retryable `duplicate` and leaves the original operation and task unchanged

#### Scenario: Busy does not reserve an operation

- **WHEN** a valid request is rejected temporarily because queue capacity is unavailable
- **THEN** the engine returns retryable `busy` without creating a deduplication record or executing the request

#### Scenario: Duplicate reply does not terminalize twice

- **WHEN** an identical `message.reply` retry arrives after the first delivery was accepted
- **THEN** the engine replays the cached delivery result without applying another terminal transition

### Requirement: Ordered authorization and bounded admission

The router SHALL authenticate the active binding and verify the claimed sender runtime, intended local recipient runtime, and exact room before consulting task or deduplication state. It SHALL then validate version, envelope, expiry, content, schema, and effective limits before deduplication and capacity decisions. Invalid credentials SHALL return `unauthorized`; room mismatch SHALL return `cross_room`; neither response SHALL reveal task or deduplication existence.

#### Scenario: Invalid binding is rejected before lookup

- **WHEN** a message has missing, invalid, stale, or sender-mismatched binding credentials
- **THEN** the router returns `unauthorized` before task or deduplication lookup

#### Scenario: Cross-room delivery is isolated

- **WHEN** an authenticated sender addresses a different room
- **THEN** the router returns `cross_room` without exposing peer, task, or deduplication information

#### Scenario: Wrong runtime reply is rejected before mutation

- **WHEN** a reply comes from a runtime other than the expected target or targets a request owned by another runtime
- **THEN** the router rejects it before disclosing or mutating task state

#### Scenario: Capacity remains bounded

- **WHEN** a valid new request exceeds the effective inbound queue capacity
- **THEN** the router returns retryable `busy` and does not reserve or execute the request

### Requirement: Explicit operation handling and concurrent correlation

The router SHALL dispatch request, reply, notification, status, cancellation, and peer-description operations without transport framing or Pi transcript inference. A request acknowledgement SHALL represent admission only, a reply acknowledgement SHALL represent terminal-update delivery only, and a notification SHALL create no task or logical reply. Concurrent outbound and inbound requests SHALL remain independently addressable, and nested operations SHALL preserve parent trace metadata without changing request ownership.

#### Scenario: Notifications do not create tasks

- **WHEN** a valid `message.notify` is delivered
- **THEN** the router returns a delivery acknowledgement, creates no task, and emits no logical reply

#### Scenario: Out-of-order replies remain correlated

- **WHEN** two outbound requests are active and their valid replies arrive in reverse order
- **THEN** each reply completes only its matching request ID

#### Scenario: Nested request preserves ownership

- **WHEN** an inbound task creates a nested operation with `parentOperationId` while another task is active
- **THEN** the nested operation retains causal metadata without changing either task's explicit owner or request ID

### Requirement: Stable protocol errors and conformance seams

The engine SHALL expose stable errors with a bounded message, code, retryability, and safe optional details. It SHALL implement the v1 error taxonomy, including `malformed`, `incompatible`, `expired`, `cross_room`, `ambiguous`, `busy`, `unauthorized`, `oversized`, `duplicate`, `cancelled`, `unreachable`, `not_found`, `not_cancelable`, `invalid_content`, `invalid_reply`, and `internal`. Protocol and router behavior SHALL be testable with in-memory binding, transport, task-executor, and clock fakes without opening sockets or invoking Pi.

#### Scenario: Retryability follows error class

- **WHEN** the engine returns `busy` or `unreachable` while the deadline permits retry
- **THEN** the error is marked retryable and may include a bounded retry delay

#### Scenario: Permanent validation failure is stable

- **WHEN** an operation is malformed, oversized, unauthorized, cross-room, expired, or a conflicting duplicate
- **THEN** the engine returns the corresponding non-retryable error without mutating task state

#### Scenario: Protocol conformance runs without external components

- **WHEN** a test supplies in-memory binding, transport, executor, and clock fakes
- **THEN** it can exercise validation, routing, state transitions, expiry, cancellation, deduplication, and correlation without sockets, filesystem discovery, or Pi UI/lifecycle code
