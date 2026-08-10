## Why

P2P-002 merged the authoritative transport-independent v1 protocol contract, but the production protocol and router modules remain stubs. P2P-011 is needed now to turn that contract into a deterministic, bounded runtime engine before the Pi adapter and end-to-end integration work depend on it.

## What Changes

- Implement the versioned v1 envelope, operation payloads, typed content, operation responses, and protocol capability projection.
- Implement protocol-specific validation for IDs, timestamps, versions, content, local Draft 2020-12 schemas, envelope/schema limits, and stable protocol errors.
- Implement inbound and outbound task records with the specified transitions, terminal immutability, cancellation races, absolute expiry, monotonic post-admission deadlines, and bounded retention.
- Implement runtime-scoped retry deduplication for `(senderRuntimeId, operationId)` with canonical immutable-operation fingerprints and acknowledgement replay.
- Implement routing policy and dispatch ordering for authentication context, target/room authorization, validation, deduplication, capacity, task admission, reply correlation, cancellation, status, and notification handling.
- Provide protocol/router interfaces that can be exercised by in-memory binding, executor, and transport fakes.
- Add focused conformance tests for concurrency, nesting, malformed input, expiry/cancellation races, deduplication, authorization ordering, terminal immutability, retention, and structured replies.
- Add the selected standards-compliant JSON Schema validator as an explicit runtime dependency; do not rely on Pi or development-only transitive dependencies.
- Do not alter transport framing, discovery persistence/leases, identity/room derivation, or Pi-facing tools and lifecycle integration.

## Capabilities

### New Capabilities

- `v1-protocol-engine`: Runtime implementation of the existing v1 protocol contract, including validation, task lifecycle, routing, deduplication, bounded resources, and conformance seams.

### Modified Capabilities

None. The existing `pi-to-pi-v1-protocol` requirements remain authoritative and are not changed.

## Impact

The primary implementation surface is `src/protocol/messages.ts`, `src/protocol/errors.ts`, `src/protocol/task-state.ts`, protocol-specific validation, and `src/router/*`. The existing discovery-only Agent Card validation remains a separate concern; only the protocol capability projection may be added alongside that model. A production JSON Schema dependency and focused protocol/router tests will be added. Transport, discovery, identity/room, Pi adapter, and end-to-end integration remain owned by their parallel issues.
