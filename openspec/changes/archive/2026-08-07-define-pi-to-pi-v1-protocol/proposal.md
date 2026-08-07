## Why

Pi-to-Pi currently has an architectural exploration but no authoritative, transport-independent contract for peer requests, replies, notifications, or task state. Issue #3 is the right point to fix this before protocol, Pi lifecycle, and transport implementations evolve independently against incompatible assumptions.

## What Changes

- Define a versioned JSON envelope with explicit operation and logical request correlation, session/runtime identity, room scope, timestamps, tracing, and causal parent metadata.
- Define the v1 operations `peer.describe`, `message.request`, `message.reply`, `message.notify`, `task.status`, and `task.cancel`.
- Define admission acknowledgements separately from asynchronous terminal task replies.
- Define the task state machine, terminal outcomes, cooperative cancellation, absolute expiry, and bounded queue/resource limits.
- Define text and structured JSON content plus bounded, local-only JSON Schema 2020-12 expected responses.
- Define exact version compatibility and protocol capability advertisement without replacing the existing discovery-only Agent Card contract.
- Define retry-safe deduplication, deterministic operation fingerprints, retention, runtime-reload boundaries, and the honest no-offline-delivery guarantee.
- Define room isolation, binding-authenticated identity checks, stable protocol error codes, and conformance examples.
- Keep issue #3 specification-only; protocol engine, task store, Pi adapter, transport, and end-to-end wiring remain follow-up implementation work.

## Capabilities

### New Capabilities

- `pi-to-pi-v1-protocol`: The normative transport-independent envelope, operations, task lifecycle, content/schema, compatibility, delivery, identity, security, and error contract for Pi-to-Pi v1.

### Modified Capabilities

None.

## Impact

This change adds OpenSpec contract artifacts and a canonical protocol specification for subsequent implementation issues. It establishes the API boundary for the currently reserved protocol, router, and task-store modules, and must remain compatible with the existing `identity.ts`, `room.ts`, discovery registry, lease, and lifecycle contracts. It introduces no runtime dependency, transport framing choice, persistence migration, or application-code implementation by itself.
