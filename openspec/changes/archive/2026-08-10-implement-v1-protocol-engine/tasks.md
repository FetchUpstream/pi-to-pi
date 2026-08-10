## 1. Establish protocol engine foundations

- [x] 1.1 Add an explicit Ajv 8 runtime dependency and lockfile entry for Draft 2020-12 validation.
- [x] 1.2 Define v1 constants, effective limits, UUID/trace types, typed content, envelope unions, operation payloads, operation responses, task snapshots, and protocol capability types in `src/protocol/messages.ts`.
- [x] 1.3 Define the closed v1 error-code union, bounded error/details types, retryability rules, and stable error constructors in `src/protocol/errors.ts`.
- [x] 1.4 Define narrow authenticated-binding, outbound-delivery, task-executor, cancellation, and injectable wall/monotonic clock interfaces for protocol/router fakes without importing transport or Pi types.

## 2. Implement deterministic protocol validation

- [x] 2.1 Add wire-protocol validation entry points without changing the existing discovery-only Agent Card validation contract.
- [x] 2.2 Validate serialized envelope size before full decoding, then validate protocol version, operation, required fields, UUIDv4 identifiers, UTC `Z` timestamps, trace IDs, request-ID relationships, and unknown required fields.
- [x] 2.3 Validate typed text/JSON content, expected-response metadata, effective schema size, and request/control deadline limits with deterministic protocol errors.
- [x] 2.4 Configure Draft 2020-12 schema validation with no network loader, bounded embedded/local references, annotation-only `format`, and no credential or task-body leakage.
- [x] 2.5 Implement canonical immutable-operation serialization and fingerprinting over the specified fields while excluding binding credentials and preserving array order.

## 3. Implement task state and deadlines

- [x] 3.1 Implement the authoritative task states and transition table in `src/protocol/task-state.ts`, including sender-local creation and terminal immutability.
- [x] 3.2 Implement runtime-local task records keyed by logical request ID with requester, local owner, expected target runtime, room, response contract, terminal data, and explicit inbound/outbound ownership.
- [x] 3.3 Implement admission, working, completion/failure/rejection, status snapshots, and first-terminal-transition-wins behavior.
- [x] 3.4 Implement monotonic post-admission expiry scheduling, queued-task expiry without execution, and absolute deadline preservation across retries.
- [x] 3.5 Implement scoped cancellation signals, queued versus working cancellation behavior, and bounded cleanup of active and terminal task records.

## 4. Implement deduplication, policy, and capabilities

- [x] 4.1 Implement runtime-scoped deduplication records keyed by `(senderRuntimeId, operationId)` for requests, notifications, replies, and cancellations.
- [x] 4.2 Register deduplication and task admission before acknowledging execution, replay identical results, reject conflicting fingerprints as `duplicate`, and avoid reserving transient `busy` responses.
- [x] 4.3 Implement deadline-plus-grace deduplication retention and cleanup without affecting active or replacement-runtime state.
- [x] 4.4 Implement effective envelope/schema/queue policy, bounded admission capacity, and retryable `busy` decisions.
- [x] 4.5 Implement the `peer.describe` protocol capability projection independently of the discovery Agent Card numeric version and persistence model.

## 5. Implement router dispatch and authorization ordering

- [x] 5.1 Implement router authentication and claimed sender, local recipient, and exact-room checks before task or deduplication lookup, with non-disclosing `unauthorized` and `cross_room` responses.
- [x] 5.2 Implement request admission and notification delivery, ensuring request acknowledgements represent admission only and notifications create no task or logical reply.
- [x] 5.3 Implement outbound task registration and explicit operation/request correlation so fast replies cannot become orphaned and nested operations retain parent metadata without changing ownership.
- [x] 5.4 Implement reply handling with expected-target and request-owner authorization before existence disclosure, stored-schema validation, and terminal task transition.
- [x] 5.5 Implement `task.status` authorization and snapshots, returning `not_found` only after authorization checks and retaining terminal response/failure data when available.
- [x] 5.6 Implement idempotent `task.cancel`, scoped executor signaling, cancellation race handling, and late-reply behavior for terminal tasks.
- [x] 5.7 Map validation, capacity, state, deduplication, and delivery failures to bounded stable protocol responses without exposing raw exceptions or credentials.

## 6. Add focused protocol-engine conformance tests

- [x] 6.1 Add message, response, error, capability, malformed-input, identifier, timestamp, version, and serialized-size validation tests.
- [x] 6.2 Add structured-response tests covering Draft 2020-12 schemas, local-reference restrictions, format annotation behavior, invalid admission schemas, and invalid replies that leave tasks nonterminal.
- [x] 6.3 Add task-state tests for every legal transition, illegal transitions, terminal immutability, monotonic expiry, queue expiry, and first-terminal-transition-wins races.
- [x] 6.4 Add cancellation and status tests for queued/working tasks, scoped signals, authorization ordering, idempotence, late replies, and non-disclosing unknown-task handling.
- [x] 6.5 Add deduplication tests for identical request/notification/reply/cancel retries, conflicting operation IDs, pre-ack registration, transient `busy`, retention, and cleanup.
- [x] 6.6 Add router tests proving authentication and room checks precede lookup, wrong-runtime replies do not disclose or mutate state, and capacity remains bounded.
- [x] 6.7 Add concurrency tests for independent outbound/inbound requests, reverse-order replies, nested parent metadata, and absence of global current-request correlation.
- [x] 6.8 Add fake-binding, fake-delivery, fake-executor, and fake-clock conformance coverage without sockets, discovery persistence, or Pi lifecycle/UI code.

## 7. Verify the scoped change

- [x] 7.1 Run the focused protocol/router test suite and fix failures without changing parallel transport, discovery, identity, room, or Pi-owned modules.
- [x] 7.2 Run repository typecheck, lint, and format checks for the completed engine changes.
- [x] 7.3 Confirm the implementation conforms to `openspec/specs/pi-to-pi-v1-protocol/spec.md` and leaves concrete transport, discovery, Pi adapter, and end-to-end integration for their owning issues.
