## Why

Pi-to-Pi currently has no reliable discovery contract: agent-card validation, filesystem registry layout, and lease management are stubs. Without a versioned card and instance-owned lease, peers can overwrite one another, stale processes can remove replacement records, and display names can become unsafe routing or filesystem identifiers.

This change establishes the discovery and presence foundation needed before transport and message routing can be implemented.

## What Changes

- Define a versioned Agent Card contract for session identity, runtime identity, display metadata, capabilities, state, context usage, and endpoint information.
- Define a per-user runtime root and room-scoped registry layout with records keyed by runtime instance ID.
- Consume the canonical room identity/storage key supplied by the room-derivation work; never use display names or raw room input as registry filenames.
- Define atomic card publication, serialized self-renewal, ownership checks, expiry, and stale-record cleanup.
- Define cross-platform private-directory/file requirements for POSIX and Windows.
- Define strict validation and bounded handling for malformed, incompatible, or expired cards.
- Keep the registry discovery-only: it carries presence metadata, not message bodies or task state.
- Defer mandatory capability-token authentication to the later transport/security design while preserving endpoint/runtime binding points.

## Capabilities

### New Capabilities

- `agent-card-registry`: Versioned Agent Cards, room-scoped runtime-instance registry layout, lease renewal/expiry, atomic publication, validation, and cleanup.

### Modified Capabilities

<!-- No existing capabilities are currently defined in openspec/specs/. -->

## Impact

- Affects `src/protocol/agent-card.ts`, `src/protocol/validation.ts`, `src/discovery/registry.ts`, and `src/discovery/lease.ts`.
- Integrates with the future session/runtime identity and room-derivation modules.
- Adds filesystem and process-level tests for concurrent starts, replacement runtimes, malformed records, expiry, permissions, and cross-platform paths.
- Introduces no external runtime dependency and does not define the local IPC wire framing or message router.
