## 1. Protocol foundations

- [x] 1.1 Define v1 operation names, envelope types, UUIDv4 identifiers, timestamps, trace fields, typed content, and operation-response unions in `src/protocol/messages.ts`.
- [x] 1.2 Define task states, terminal outcomes, legal transitions, task snapshots, and cancellation state in `src/protocol/task-state.ts`.
- [x] 1.3 Define the stable error-code taxonomy, structured error payloads, retryability, and retry-delay metadata in `src/protocol/errors.ts`.
- [x] 1.4 Define Agent Card, operation capability, content capability, and v1 limit types in `src/protocol/agent-card.ts`.
- [x] 1.5 Add protocol defaults and configurable limits for 10-minute request TTL, one-hour request maximum, 30-second control operations, 1 MiB envelopes, 64 KiB schemas, and a 32-entry queue.

## 2. Validation and fingerprints

- [x] 2.1 Implement envelope validation for required fields, operation-specific `requestId` rules, UUIDs, RFC 3339 UTC timestamps, trace IDs, expiry ordering, and payload discriminants in `src/protocol/validation.ts`.
- [x] 2.2 Implement typed content and expected-response validation using JSON Schema Draft 2020-12, local-only references, the schema-size limit, and annotation-only `format` behavior.
- [x] 2.3 Implement deterministic canonical request fingerprinting and validation that excludes binding credentials while covering immutable operation fields.
- [x] 2.4 Add validation result/error mapping that distinguishes `malformed`, `incompatible`, `expired`, `oversized`, and `invalid_content`.

## 3. Identity, room, and discovery contracts

- [x] 3.1 Implement session/runtime identity creation and lifecycle rules, including stable session IDs and per-runtime IDs, in `src/identity.ts`.
- [x] 3.2 Implement exact room identity derivation and comparison in `src/room.ts`.
- [x] 3.3 Extend discovery registry and lease contracts to advertise runtime identity, Agent Card capabilities, protocol versions, limits, and current routing endpoint.
- [x] 3.4 Implement binding-authenticated sender verification, recipient targeting, room checks, and safe `unauthorized`/`cross_room` behavior.

## 4. Task storage and deduplication

- [x] 4.1 Implement a task store with atomic state transitions, immutable terminal snapshots, request ownership, expiry timers, and optional terminal response retention in `src/router/task-store.ts`.
- [x] 4.2 Implement cooperative cancellation transitions and executor cancellation signals without affecting unrelated tasks.
- [x] 4.3 Implement runtime-scoped deduplication keyed by `(senderRuntimeId, operationId)`, canonical fingerprints, cached acknowledgments, conflicting-ID detection, and expiry-plus-ten-minute retention in `src/router/dedupe.ts`.
- [x] 4.4 Implement bounded queue admission and retryable `busy` behavior in the routing policy layer.
- [x] 4.5 Implement reload/shutdown handling so active task and deduplication state is not silently handed to a replacement runtime and lost delivery is reported as `unreachable`.

## 5. Operation routing

- [x] 5.1 Define the transport adapter contract for sending envelopes and operation responses without selecting or changing a framing protocol.
- [x] 5.2 Implement the router admission pipeline in `src/router/router.ts`: authenticate, validate destination and room, enforce expiry and limits, check deduplication, admit/queue, and return correlated responses.
- [x] 5.3 Implement `peer.describe` with Agent Card, versions, operations, capabilities, and effective limits.
- [x] 5.4 Implement `message.request` admission and asynchronous task dispatch without inferring completion from Pi lifecycle events.
- [x] 5.5 Implement `message.reply` authorization, request correlation, response-schema validation, terminal transition, duplicate handling, and delivery acknowledgment.
- [x] 5.6 Implement `message.notify` delivery acknowledgment, deduplication, and no-task/no-logical-reply semantics.
- [x] 5.7 Implement `task.status` authorization and task snapshot responses.
- [x] 5.8 Implement `task.cancel` authorization, idempotency, cancellation race handling, and current-snapshot responses.

## 6. Pi integration and public API

- [x] 6.1 Add Pi custom message/event types for inbound requests, replies, notifications, task updates, cancellation, expiry, and unreachable outcomes in `src/pi/messages.ts`.
- [x] 6.2 Integrate task admission, scoped cancellation, terminal reply sending, and expiry with the Pi lifecycle in `src/pi/lifecycle.ts` and persistence boundaries.
- [x] 6.3 Implement model-facing request/reply/notification tools with explicit request IDs, typed content, expected schemas, and the v1 outcome restrictions in `src/pi/tools.ts`.
- [x] 6.4 Ensure concurrent peer tasks are tracked independently and never rely on a global current assistant message or a single agent-end callback.

## 7. Conformance and integration tests

- [x] 7.1 Add unit tests for envelope, operation-specific ID, timestamp, trace, content, schema, version, limit, and error validation.
- [x] 7.2 Add task-store tests covering every legal transition, terminal immutability, expiry, queued cancellation, working cancellation, and completion/cancellation races.
- [x] 7.3 Add deduplication tests for identical retries, conflicting fingerprints, duplicate replies, busy retries, retention, and runtime restart boundaries.
- [x] 7.4 Add routing tests for peer discovery, request/reply correlation, notifications, status, cancellation, room isolation, authentication, and all core error codes.
- [x] 7.5 Add two-runtime integration tests using a fake transport for accepted, queued, completed, failed, rejected, cancelled, expired, oversized, and unreachable flows.
- [x] 7.6 Add reload/replacement-runtime tests proving old active state is not adopted and accepted operations are not replayed with the old ID.
- [x] 7.7 Update protocol fixtures, README/SPEC references, and test documentation with the v1 examples and transport-binding boundary.

## 8. Verification

- [x] 8.1 Run formatting, lint, typecheck, unit tests, integration tests, and production build; fix all failures.
- [x] 8.2 Review implementation behavior against every requirement and scenario in `specs/pi-to-pi-v1-protocol/spec.md`.
- [x] 8.3 Confirm the change contains no unbounded queue/input path, no cross-room task lookup, and no implicit reply correlation.
