## Context

The repository contains an architectural exploration in `SPEC.md` and placeholder protocol modules under `src/protocol/`, but no authoritative wire contract. The protocol must support independent Pi runtimes in the same room while remaining independent of transport framing. Runtime identity, session identity, room isolation, and the Pi task/session integration already exist as project concepts; this change defines how they participate in peer operations.

The design must handle asynchronous model work, explicit request/reply correlation, retries caused by unreliable delivery, cooperative cancellation, structured responses, and runtime reloads. The expected deployment is local, same-user peer communication, not a durable cross-machine job system.

## Goals / Non-Goals

**Goals:**

- Establish a small, versioned, transport-independent JSON protocol for Pi-to-Pi operations.
- Make every request, reply, notification, and task action explicitly correlatable.
- Define testable state transitions, cancellation races, expiry, deduplication, and error behavior.
- Validate structured responses with a bounded, local-only JSON Schema contract.
- Preserve room isolation and bind wire identity to the runtime registry/authentication layer.
- Provide enough peer discovery and limits for a sender to choose a compatible operation safely.

**Non-Goals:**

- Choosing a socket, HTTP, WebSocket, framing, or serialization transport.
- Providing durable offline delivery or handing active tasks across runtime reloads.
- Defining streaming, attachments, multi-peer broadcast, or a distributed scheduler.
- Replacing the Pi model/session API or exposing internal agent reasoning.
- Defining a general-purpose internet authentication system; the v1 binding supplies local credentials.

## Decisions

### Use a layered protocol rather than adopting JSON-RPC wholesale

The protocol has three layers: a canonical envelope/data model, abstract operations, and transport bindings. JSON-RPC's correlation and result/error ideas are useful, and A2A's data-model/operation/binding separation is a good precedent, but Pi-to-Pi does not implement JSON-RPC notifications because notifications need delivery acknowledgment and retry deduplication. This keeps async replies and transport choices explicit.

### Separate wire operation IDs from logical request IDs

Every envelope receives a UUIDv4 `operationId`. A task-bearing request also receives a `requestId`; the initial `message.request` requires `requestId == operationId`, while replies, status requests, and cancellation requests use new operation IDs and reference the original request ID. This prevents a reply from being inferred from the latest assistant message or an agent lifecycle event.

Each envelope also carries the sender session/runtime identity, recipient runtime ID, room ID, RFC 3339 timestamps, a stable random trace ID, and an optional causal parent operation ID. Credentials are binding metadata rather than application content and are excluded from request fingerprints.

### Use explicit admission acknowledgments and asynchronous terminal replies

`message.request` returns an admission acknowledgment (`accepted` or `queued`) and later receives exactly one explicit `message.reply`. `message.notify` returns a delivery acknowledgment but creates no task and receives no logical reply. Operation responses contain the matching operation ID and exactly one result or error. This provides observable delivery without confusing delivery acknowledgment with model completion.

### Use a public state machine with cooperative cancellation

The task state machine is `created -> accepted -> queued -> working`, with terminal outcomes `completed`, `failed`, `rejected`, `cancelled`, and `expired`. `cancelling` is a nonterminal state for a working task after a cancellation request. Cancellation is linearized against completion: the transition committed first wins. Queued work can be cancelled immediately; working Pi work receives a scoped cooperative cancellation signal and may finish before the cancellation transition commits.

### Make expiry an absolute deadline

Requests carry an absolute `expiresAt`, not a retry-relative TTL. The v1 request default is ten minutes and the maximum is one hour; control operations have a 30-second maximum. Receivers use monotonic timers after parsing the wall-clock timestamp, reject late operations, expire queued work, and do not accept a reply after the request deadline. Retries never extend the deadline.

### Constrain structured responses to JSON Schema 2020-12

Structured content is explicitly typed as JSON rather than encoded inside text. An expected response schema uses JSON Schema Draft 2020-12, is validated before admission, is limited to local/embedded references, and cannot cause network fetches. Both sender and receiver validate replies. `format` remains annotation-only by default so implementations do not silently disagree about semantic format assertions. Schemas are capped at 64 KiB.

### Use exact version advertisement with compatible extension rules

The wire version is `1.0`, and `peer.describe` advertises exact supported versions. A future minor version may add optional fields or operations; an implementation may advertise `1.0` only when it honors the v1 contract. Unknown optional fields are ignored, unknown operations or unsupported major versions return `incompatible`, and no silent downgrade occurs.

### Make retries at-least-once safe with runtime-scoped deduplication

Mutating operations are keyed by `(senderRuntimeId, operationId)`. The receiver computes a deterministic RFC 8785-style canonical JSON fingerprint over immutable operation data and stores the fingerprint, admission/result, and task reference before acknowledging acceptance. An identical retry replays the cached result; the same ID with different content returns `duplicate` and is never executed. Records remain through the request deadline plus a ten-minute grace period, but active deduplication is not durable across runtime restarts. `busy` is transient and does not reserve an operation, so the sender may retry the same ID before expiry.

### Keep reloads runtime-scoped

A session ID may remain stable across `/reload`, but a runtime ID identifies one live routing endpoint. V1 does not hand active tasks to a replacement runtime or offer offline delivery. A sender that discovers a new runtime must not replay an accepted operation there; it creates a new operation with a new ID. Graceful shutdown may attempt system-generated cancellation/failure replies, but abrupt loss is reported locally as `unreachable`.

### Bind identity, room, and authentication before deduplication

The binding authenticates every operation using its local capability mechanism. The receiver verifies that the authenticated runtime matches the claimed registry identity, that the recipient runtime is itself, and that the room ID matches exactly before consulting deduplication state. Invalid credentials return `unauthorized`; room mismatch returns `cross_room`. This prevents stale or unauthorized callers from probing task IDs or dedupe records.

### Use a small string error taxonomy

Errors are structured objects with a stable string `code`, concise message, retryability, and optional safe details. The core codes are `malformed`, `incompatible`, `expired`, `cross_room`, `ambiguous`, `busy`, `unauthorized`, `oversized`, `duplicate`, `cancelled`, and `unreachable`, with `not_found`, `not_cancelable`, `invalid_content`, `invalid_reply`, and `internal` for operation-specific cases. `rejected` is a task outcome, not an error code. `ambiguous` and `unreachable` are commonly produced locally by name resolution or the transport binding.

## Risks / Trade-offs

- **[Runtime loss can strand accepted work]** → V1 explicitly documents no offline delivery or reload handoff, scopes deduplication to a runtime, and reports lost communication as `unreachable` instead of pretending the task completed.
- **[Cooperative cancellation may not stop model execution immediately]** → Expose `cancelling`, scope cancellation to one peer task, enforce the request deadline, and make completion-vs-cancellation ordering atomic.
- **[Clock skew can produce premature expiry]** → Use RFC 3339 UTC timestamps, reject unreasonable future timestamps, and use monotonic timers after admission. The expected same-host deployment makes a small clock-skew allowance sufficient.
- **[Unbounded input can exhaust a runtime]** → Enforce a 1 MiB envelope limit, a 64 KiB schema limit, a bounded default queue of 32, and advertise stricter peer limits through `peer.describe`.
- **[Different JSON Schema implementations may disagree]** → Pin Draft 2020-12, prohibit remote references, make `format` annotation-only, validate schemas and responses on both sides, and add conformance fixtures.
- **[Same-user capability tokens are not a defense against a malicious same-user process]** → Treat registry permissions and runtime tokens as protection against stale or accidental peers; leave stronger authentication schemes to future bindings.
- **[A protocol-only change can drift from implementation]** → Keep the capability spec normative, derive TypeScript discriminated unions and validators from the same definitions where practical, and add protocol-level tests before transport integration.

## Migration Plan

1. Treat the current protocol files as unimplemented placeholders; no existing wire compatibility must be preserved.
2. Add the protocol data types, constants, validators, error objects, and state-transition logic behind the existing module boundaries.
3. Add unit/conformance tests for every requirement and example, including malformed input and race cases.
4. Integrate the operation dispatcher with runtime identity, room checks, task/session lifecycle, and the selected transport adapter.
5. Publish the v1 capability/version data through `peer.describe` and update project documentation to reference the normative contract.
6. Rollback is code-level: disable the new dispatcher/adapter integration and remove the change implementation. No durable schema migration is required because v1 active task state is runtime-scoped and no offline queue is introduced.

## Open Questions

No v1 architectural decisions remain open. Future changes may define streaming, attachments, durable offline delivery, runtime task handoff, richer authorization, or additional authentication schemes without changing the v1 contract.