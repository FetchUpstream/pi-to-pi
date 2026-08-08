## ADDED Requirements

### Requirement: Common protocol envelope

The system SHALL exchange operations using a versioned JSON envelope containing `protocolVersion`, `operation`, `operationId`, sender session/runtime identity, `recipientRuntimeId`, `roomId`, `createdAt`, `expiresAt`, `traceId`, and an operation payload. The v1 wire version SHALL be the string `"1.0"`. `operationId` and task `requestId` values SHALL be UUIDv4 strings. `createdAt` and `expiresAt` SHALL be RFC 3339 UTC timestamps ending in `Z`. `traceId` SHALL be a stable 16-byte random identifier represented by 32 lowercase hexadecimal characters.
An envelope MAY include `parentOperationId` as a UUIDv4 causal reference for a nested or otherwise related operation. `parentOperationId` is diagnostic context only and SHALL never replace the explicit logical `requestId` used for task correlation.

The wire routing identity SHALL use the current runtime `runtimeId`. When a discovery Agent Card exposes the same identity as `runtimeInstanceId`, the integration boundary SHALL verify that the values refer to the same runtime before routing.

A task-bearing initial `message.request` SHALL include `requestId` equal to its `operationId`. A `message.reply`, `task.status`, or `task.cancel` operation SHALL use a new `operationId` and include the logical target `requestId`. `peer.describe` and `message.notify` SHALL omit `requestId`.

#### Scenario: Valid initial request envelope

- **WHEN** a sender creates a `message.request` with protocol version `1.0`, matching UUIDv4 operation/request IDs, valid sender and recipient runtime identities, an exact room, valid UTC timestamps, a future expiry, and a valid payload
- **THEN** the receiver can validate the envelope and continue to operation processing

#### Scenario: Initial request IDs do not match

- **WHEN** a `message.request` has different `operationId` and `requestId` values
- **THEN** the receiver rejects it with `malformed` before admitting a task

#### Scenario: Invalid timestamp or trace identifier

- **WHEN** an envelope contains a non-UTC timestamp, an expiry that is not later than creation, or a trace identifier that is not 32 lowercase hexadecimal characters
- **THEN** the receiver rejects it with `malformed`

### Requirement: Explicit operation correlation and responses

Every operation that requests processing SHALL receive an operation response containing the original `operationId` and `traceId`. An operation response SHALL contain exactly one of `result` or `error`, never both. A logical task reply SHALL identify the original `requestId` explicitly and SHALL NOT be inferred from the latest assistant message, an `agent_end` event, transcript ordering, or a global current-request variable.

A successful `message.request` response SHALL acknowledge admission, not model completion. A successful `message.reply` response SHALL acknowledge delivery of the terminal update, not create a second task outcome.

#### Scenario: Admission response correlation

- **WHEN** a receiver accepts a `message.request` with operation ID `op-1`
- **THEN** its operation response contains operation ID `op-1` and a result identifying the same logical request and admission state

#### Scenario: Explicit reply correlation

- **WHEN** a receiver sends a `message.reply` for request ID `req-1` as operation `op-2` while other tasks or assistant messages exist
- **THEN** the original sender applies the reply only to `req-1`

#### Scenario: Concurrent nested requests retain correlation

- **WHEN** a receiver handles concurrent requests and one request creates a nested operation with `parentOperationId` while another task also completes

- **THEN** each terminal reply is applied to its explicit `requestId`, and the causal parent does not cause either task to be cross-wired

#### Scenario: Response contains both result and error

- **WHEN** an operation response contains both `result` and `error`
- **THEN** the receiver treats the response as `malformed` and applies neither value

### Requirement: Peer description and protocol capability advertisement

The system SHALL support `peer.describe` without creating a task. Its successful result SHALL contain the discovery Agent Card and a protocol capability projection with:

- exact supported wire versions, including `"1.0"` when v1 is supported;
- supported operation names;
- supported typed-content capabilities and structured-response support;
- cancellation and notification support;
- effective request, control, envelope, schema, and queue limits.

The capability projection SHALL remain distinct from the discovery card's numeric Agent Card version and presence-only fields. A peer MAY advertise stricter limits than the v1 defaults. The v1 defaults SHALL be a 1 MiB serialized envelope, a 64 KiB response schema, and 32 queued inbound requests.

#### Scenario: Describe a compatible peer

- **WHEN** a sender invokes `peer.describe` using protocol version `1.0`
- **THEN** the peer returns its discovery card and protocol capabilities, includes `1.0` in supported versions, and reports effective limits

#### Scenario: Unsupported description operation

- **WHEN** a peer does not support `peer.describe`
- **THEN** it returns `incompatible` without creating a task

#### Scenario: Sender exceeds an advertised limit

- **WHEN** a sender creates an envelope or expected-response schema larger than the peer's advertised limit
- **THEN** the sender rejects it locally or the peer rejects it with `oversized` before task admission

### Requirement: Request, reply, and notification operations

The system SHALL support these payloads:

- `message.request`, carrying typed content, optional expected-response metadata, and optional application metadata;
- `message.reply`, carrying an explicit target `requestId`, one terminal outcome, and optional typed content or structured failure information;
- `message.notify`, carrying typed content and metadata without creating a task or requiring a logical reply.

A successful `message.request` operation response SHALL acknowledge `accepted` or `queued` admission. A `message.reply` SHALL support outcomes `completed`, `failed`, `rejected`, `cancelled`, and `expired`. A completed reply SHALL include content; failed and rejected replies SHALL include structured failure information. `cancelled` and `expired` replies SHALL be system-generated rather than produced by the model-facing reply API.

#### Scenario: Request is admitted

- **WHEN** a valid `message.request` passes identity, room, expiry, content, schema, and capacity checks
- **THEN** the receiver records the task and returns an acknowledgement with state `accepted` or `queued`

#### Scenario: Reply completes the request

- **WHEN** the expected recipient sends a `message.reply` with outcome `completed` and content satisfying the stored response contract
- **THEN** the original sender records the matching request as completed and acknowledges the reply operation

#### Scenario: Notification is delivered

- **WHEN** a valid `message.notify` is accepted
- **THEN** the receiver returns a delivery acknowledgement, creates no task, and emits no logical `message.reply`

#### Scenario: Late reply to a cancelled request

- **WHEN** a `message.reply` arrives after the referenced request reached `cancelled`
- **THEN** the receiver returns `cancelled` and does not change the terminal task state

### Requirement: Task lifecycle and terminal outcomes

The system SHALL expose task states `created`, `accepted`, `queued`, `working`, `cancelling`, `completed`, `failed`, `rejected`, `cancelled`, and `expired`. `created` SHALL be sender-local. A receiver SHALL transition admitted tasks through `accepted`, optionally `queued`, and `working`, and SHALL permit only one terminal transition.

The valid transitions SHALL include:

- `created` to `accepted`, `rejected`, or `expired`;
- `accepted` to `queued`, `working`, `rejected`, `cancelling`, `cancelled`, or `expired`;
- `queued` to `working`, `rejected`, `cancelling`, `cancelled`, or `expired`;
- `working` to `completed`, `failed`, `rejected`, `cancelling`, or `expired`;
- `cancelling` to `cancelled`, `completed`, `failed`, or `expired`.

Terminal states SHALL be immutable, including their outcome, response correlation, content, and failure information. `rejected` is a terminal task outcome and is distinct from a protocol error returned before task creation.

#### Scenario: Queued request begins work

- **WHEN** an admitted task leaves the inbound queue
- **THEN** its state changes from `queued` to `working` before model execution begins

#### Scenario: Terminal state is immutable

- **WHEN** a task reaches `completed`
- **THEN** later status, reply, notification, cancellation, or expiry operations cannot change it to another outcome

#### Scenario: Admission rejection

- **WHEN** a request fails a permanent admission check after its sender and target are authenticated
- **THEN** the sender records a terminal `rejected` outcome with the protocol error as its reason

### Requirement: Cooperative cancellation

The system SHALL support `task.cancel` as an idempotent operation targeting a logical `requestId`. Only the original requester or an authorized local task owner SHALL cancel the task remotely. Cancelling queued work SHALL remove it from runnable work and transition it directly to `cancelled` when execution has not started. Cancelling working work SHALL first transition it to `cancelling` and signal only that task's executor.

If completion, failure, expiry, or cancellation races, the first atomically committed terminal transition SHALL win. Cancelling an already completed, failed, rejected, or expired task SHALL return `not_cancelable` with its current snapshot. Cancelling an already cancelled task SHALL succeed idempotently.

#### Scenario: Queued task is cancelled

- **WHEN** the original requester cancels a task still in the queue
- **THEN** the receiver removes it from runnable work, transitions it to `cancelled`, and returns the cancelled snapshot

#### Scenario: Working task enters cancellation

- **WHEN** the original requester cancels a task in `working`
- **THEN** the receiver transitions it to `cancelling` and signals only that task's executor

#### Scenario: Completion wins a cancellation race

- **WHEN** completion commits before the cancellation transition
- **THEN** the task remains `completed` and the cancellation response reports `not_cancelable`

### Requirement: Task status inspection

The system SHALL support `task.status` with a target `requestId`. The original requester SHALL be authorized to inspect its request at the destination, and an authorized local owner MAY inspect local task state. A status result SHALL include the request ID, current state, last update time, expiry, cancellation-requested indicator when applicable, and retained terminal content or failure information when available. Unknown or purged requests SHALL return `not_found` only after authorization checks.

#### Scenario: Status of an active request

- **WHEN** an authorized requester invokes `task.status` for a queued request
- **THEN** the response identifies the request and reports state `queued` without creating another task

#### Scenario: Status of a completed request

- **WHEN** an authorized requester invokes `task.status` for a completed request and terminal response retention is enabled
- **THEN** the response includes state `completed` and the stored terminal response

#### Scenario: Unauthorized status lookup

- **WHEN** a runtime that did not originate the request invokes `task.status`
- **THEN** the receiver returns `unauthorized` without revealing whether the request exists

### Requirement: Absolute expiry and bounded resources

The sender SHALL include `expiresAt` on every operation. A normal request SHALL default to a ten-minute lifetime and SHALL NOT exceed one hour. Control operations such as `peer.describe`, `task.status`, and `task.cancel` SHALL NOT exceed 30 seconds. A `message.reply` SHALL use the original request deadline or an earlier deadline. Retries SHALL NOT extend any deadline.

The receiver SHALL reject an operation at or after its deadline, SHALL expire queued tasks at their absolute deadline, and SHALL not accept terminal replies after the request deadline. After admission, deadline enforcement SHALL use a monotonic timer. The receiver SHALL enforce effective envelope, schema, and queue limits and SHALL return `busy` when temporary capacity is unavailable.

#### Scenario: Expired request before admission

- **WHEN** a request arrives at or after its `expiresAt`
- **THEN** the receiver returns `expired` and does not enqueue or execute it

#### Scenario: Queued request reaches its deadline

- **WHEN** a queued request reaches `expiresAt` before work begins
- **THEN** the receiver transitions it to `expired` and does not start model execution

#### Scenario: Retry cannot extend expiry

- **WHEN** a sender retries an operation with the same ID after its original deadline
- **THEN** the receiver returns `expired` rather than accepting the retry with a new deadline

#### Scenario: Capacity is exhausted

- **WHEN** the receiver's bounded queue cannot accept a valid new request
- **THEN** it returns retryable `busy` and does not execute or reserve the request

### Requirement: Typed content and structured response validation

The protocol SHALL represent content as an explicit text value or JSON value and SHALL not require receivers to guess whether text contains JSON. An expected structured response SHALL require JSON content and contain a JSON Schema Draft 2020-12 schema. Schemas SHALL be validated before admission, SHALL be no larger than 64 KiB, SHALL use only embedded or local references, and SHALL not trigger network access. `format` SHALL be treated as an annotation unless an explicitly supported assertion vocabulary is declared.

The recipient SHALL validate a completed reply before sending when an expected schema exists, and the requester SHALL validate it again on receipt. A reply that fails validation SHALL return `invalid_reply` and SHALL not terminalize an otherwise active request.

#### Scenario: Valid structured response

- **WHEN** a request contains a valid Draft 2020-12 schema and the recipient replies with a matching JSON value
- **THEN** both sides accept the response and the request can transition to `completed`

#### Scenario: Invalid schema at admission

- **WHEN** an expected response schema is malformed, unsupported, oversized, or contains a remote reference
- **THEN** the receiver rejects the request with `malformed`, `incompatible`, or `oversized` as appropriate before admission

#### Scenario: Reply fails schema validation

- **WHEN** a reply's JSON value does not satisfy the stored expected schema
- **THEN** the receiver returns `invalid_reply` and leaves the request nonterminal until a valid reply, failure, cancellation, or expiry occurs

### Requirement: Version compatibility and extensibility

The v1 protocol version SHALL be `1.0`. Peers SHALL advertise exact supported versions through `peer.describe`. A receiver SHALL reject an unsupported major version or unavailable operation with `incompatible`. Future minor versions SHALL add only backward-compatible optional fields or operations, and a peer SHALL advertise `1.0` only when it honors all v1 semantics. Receivers SHALL ignore unknown optional fields and SHALL never silently reinterpret unknown operations or required fields.

#### Scenario: Version 1.0 negotiation

- **WHEN** both peers advertise `1.0`
- **THEN** the sender may use v1 operations and the receiver processes the envelope under v1 rules

#### Scenario: Unsupported major version

- **WHEN** a sender uses protocol version `2.0` and the receiver supports only v1
- **THEN** the receiver returns `incompatible` without admitting a task

#### Scenario: Optional extension field

- **WHEN** a v1 receiver receives an unknown non-required extension field
- **THEN** it ignores the field and processes the known operation fields

### Requirement: Retry-safe deduplication

The receiver SHALL deduplicate `message.request`, `message.notify`, `message.reply`, and `task.cancel` using the composite key `(senderRuntimeId, operationId)`. It SHALL compute a deterministic canonical JSON fingerprint over immutable operation data, including operation, IDs, sender/recipient identity, room, timestamps, trace/parent fields, and payload, while excluding binding credentials. It SHALL store the fingerprint and admission or delivery result before acknowledging execution and retain records through at least the request deadline plus ten minutes.

An identical retry SHALL replay the previous acknowledgement or terminal delivery result without re-executing work. Reuse of an operation ID with a different fingerprint SHALL return `duplicate` and SHALL not alter existing state. `task.cancel` SHALL also be idempotent by target request state. A transient `busy` response SHALL not reserve an operation. Deduplication state SHALL be scoped to one runtime and need not survive runtime replacement.

#### Scenario: Identical request retry

- **WHEN** a sender retries an admitted `message.request` with the same runtime identity, operation ID, immutable fields, and payload
- **THEN** the receiver returns the original admission result and does not create or execute a second task

#### Scenario: Conflicting operation ID reuse

- **WHEN** a sender reuses an operation ID with different content or destination fields
- **THEN** the receiver returns `duplicate` and leaves the original operation unchanged

#### Scenario: Duplicate reply retry

- **WHEN** a sender retries an already accepted `message.reply` with identical content
- **THEN** the receiver returns the cached delivery result and does not apply a second terminal transition

### Requirement: Room isolation and authenticated identity

Every operation SHALL be authenticated by the active transport binding. The receiver SHALL verify that the authenticated runtime matches the claimed sender runtime, that `recipientRuntimeId` identifies the intended local runtime, and that the envelope's `roomId` exactly matches the receiving room before consulting task or deduplication state. Binding credentials SHALL not be treated as application content and SHALL not be included in request fingerprints or ordinary logs.

Invalid or missing credentials SHALL return `unauthorized`. A room mismatch SHALL return `cross_room`. These checks SHALL not reveal task existence or deduplication records to an unauthorized or cross-room caller.

#### Scenario: Authenticated same-room request

- **WHEN** a runtime presents valid binding credentials for the claimed sender and sends to a destination in the same room
- **THEN** the receiver continues with version, envelope, expiry, content, and admission validation

#### Scenario: Invalid capability

- **WHEN** a sender presents missing, invalid, or stale credentials
- **THEN** the receiver returns `unauthorized` before task lookup or deduplication

#### Scenario: Cross-room request

- **WHEN** an otherwise authenticated sender addresses a different room
- **THEN** the receiver returns `cross_room` and does not expose peer or task information

### Requirement: Runtime-scoped reload and delivery behavior

A runtime ID SHALL identify one live process/runtime instance, while a session ID MAY remain stable across reload. V1 SHALL not provide active task handoff, durable offline delivery, or durable deduplication across runtime replacement. A sender SHALL not replay an accepted operation at a replacement runtime using the old operation ID; it SHALL create a new operation with a new ID after rediscovery.

If a runtime is lost before a logical exchange completes, the sender SHALL report local delivery failure as `unreachable` when the binding cannot establish delivery. It SHALL not infer task completion or failure from the missing runtime. Graceful shutdown MAY send system-generated terminal cancellation or failure replies when the original target remains reachable, but this is not an offline guarantee.

#### Scenario: Destination runtime reloads

- **WHEN** a destination runtime shuts down and a replacement registers with a new runtime ID
- **THEN** the old runtime's active task and deduplication state is not silently adopted by the replacement

#### Scenario: Sender rediscovers a peer

- **WHEN** a sender resolves a replacement runtime after an accepted operation became unreachable
- **THEN** it creates a new operation ID rather than replaying the accepted operation against the replacement

#### Scenario: Abrupt runtime loss

- **WHEN** the sender cannot reach the runtime that accepted a request
- **THEN** the sender reports local `unreachable` status and does not infer completion or failure from the missing runtime

### Requirement: Stable protocol errors

Operation errors SHALL contain a stable string `code`, a bounded human-readable `message`, a boolean `retryable`, and optional safe structured details. The v1 error codes SHALL include `malformed`, `incompatible`, `expired`, `cross_room`, `ambiguous`, `busy`, `unauthorized`, `oversized`, `duplicate`, `cancelled`, `unreachable`, `not_found`, `not_cancelable`, `invalid_content`, `invalid_reply`, and `internal`.

`busy` and `unreachable` SHALL be retryable while the deadline permits. `malformed`, `incompatible`, `expired`, `cross_room`, `unauthorized`, `oversized`, conflicting `duplicate`, `invalid_reply`, and `not_cancelable` SHALL not be retried unchanged. `ambiguous` SHALL be returned by local target resolution when a human-facing peer name does not identify exactly one runtime. Retryable errors MAY include a bounded retry delay.

#### Scenario: Retryable busy error

- **WHEN** a valid request is rejected because the receiver queue is full
- **THEN** the error code is `busy`, it is marked retryable, and the sender may retry the same operation ID before expiry

#### Scenario: Permanent malformed error

- **WHEN** an operation is missing required envelope fields
- **THEN** the receiver returns `malformed` marked non-retryable and does not admit a task

#### Scenario: Ambiguous local target

- **WHEN** a local peer name resolves to more than one eligible runtime in the current room
- **THEN** the sender returns `ambiguous` with the candidate runtime addresses and sends no operation to an arbitrary target

## Examples

### Request and asynchronous reply

An initial request uses one operation ID for both the operation and logical request:

```json
{
  "protocolVersion": "1.0",
  "operation": "message.request",
  "operationId": "8b6f4f7e-1fc4-4c4e-8e4c-5a3c7427c4d1",
  "requestId": "8b6f4f7e-1fc4-4c4e-8e4c-5a3c7427c4d1",
  "sender": {"sessionId": "session-a", "runtimeId": "runtime-a"},
  "recipientRuntimeId": "runtime-b",
  "roomId": "room-1",
  "createdAt": "2026-08-07T10:00:00.000Z",
  "expiresAt": "2026-08-07T10:10:00.000Z",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "payload": {
    "content": {"type": "text", "text": "Review this change."}
  }
}
```

A later reply uses a new operation ID and the original request ID:

```json
{
  "protocolVersion": "1.0",
  "operation": "message.reply",
  "operationId": "2e7a11d9-aaf9-4b42-b46b-39d16f6a5f06",
  "requestId": "8b6f4f7e-1fc4-4c4e-8e4c-5a3c7427c4d1",
  "sender": {"sessionId": "session-b", "runtimeId": "runtime-b"},
  "recipientRuntimeId": "runtime-a",
  "roomId": "room-1",
  "createdAt": "2026-08-07T10:02:00.000Z",
  "expiresAt": "2026-08-07T10:10:00.000Z",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "parentOperationId": "8b6f4f7e-1fc4-4c4e-8e4c-5a3c7427c4d1",
  "payload": {
    "outcome": "completed",
    "content": {"type": "text", "text": "Reviewed successfully."}
  }
}
```

### Admission and terminal state sequence

```text
sender-local: created
      │ message.request operation
      ▼
receiver: accepted ──▶ queued ──▶ working
                                      │
                                      ├── message.reply(completed)
                                      ├── message.reply(failed)
                                      ├── message.reply(rejected)
                                      ├── system cancellation → cancelled
                                      └── deadline → expired
```
