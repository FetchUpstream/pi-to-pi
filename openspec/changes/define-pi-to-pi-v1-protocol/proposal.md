## Why

Pi-to-Pi currently has only an architectural exploration, so peers cannot interoperate on a precise request, reply, notification, or task contract. Issue #3 identified the missing decisions around correlation, lifecycle, cancellation, compatibility, structured responses, expiry, retries, authentication, and runtime reloads. A normative v1 protocol now provides the stable boundary needed before implementing the protocol modules and runtime integration.

## What Changes

- Define a transport-independent JSON envelope with explicit operation IDs, logical request IDs, sender/recipient runtime identity, room scope, timestamps, tracing, and typed payloads.
- Define the v1 operations `peer.describe`, `message.request`, `message.reply`, `message.notify`, `task.status`, and `task.cancel`.
- Define request admission, reply correlation, notification acknowledgment, task state transitions, terminal outcomes, cooperative cancellation, and expiry behavior.
- Define JSON Schema 2020-12 handling for expected structured responses, including local-reference and size constraints.
- Define version advertisement and compatibility rules for protocol v1.
- Define bounded message and queue limits, retry-safe deduplication, request fingerprinting, and retention semantics.
- Define room isolation, runtime-scoped reload behavior, authentication requirements, and the protocol error taxonomy.
- Add conformance-oriented examples and tests for valid envelopes, correlation, lifecycle races, expiry, cancellation, deduplication, and invalid messages.

## Capabilities

### New Capabilities

- `pi-to-pi-v1-protocol`: Normative peer-to-peer protocol envelope, operations, task lifecycle, content/schema contract, compatibility, security, and delivery semantics.

### Modified Capabilities

None.

## Impact

The change establishes the public contract for the placeholder modules under `src/protocol/` and their integration with runtime identity, rooms, configuration, and task execution. It will add or update protocol types, validators, task state handling, peer discovery, and tests. Transport framing remains outside this change; transport adapters must bind to the defined operations without changing their semantics. No external service or dependency is required by the protocol definition.
