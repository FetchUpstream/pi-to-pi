## Why

Pi-to-Pi needs a bounded, local-only transport before discovery and routing can be implemented. Node exposes different IPC primitives by platform—Unix domain sockets on Linux/macOS and named pipes on Windows—so the framing, deadline, cleanup, and endpoint rules must be proven across all three platforms rather than assumed from a Linux-only prototype.

## What Changes

- Add throwaway spike code and tests comparing length-prefixed JSON over `node:net` with HTTP/JSON-RPC over local IPC.
- Exercise Unix domain sockets on Linux and macOS and named pipes on Windows using the Node runtime supported by Pi extensions.
- Verify partial-read handling, malformed and oversized-frame rejection, bounded connect/write/read deadlines, abort behavior, bind/startup behavior, and endpoint cleanup.
- Confirm a short, platform-appropriate endpoint naming strategy that avoids POSIX socket path limits.
- Record an ADR selecting the smallest reliable approach, with rejected alternatives and evidence.
- Define the transport-only surface required by later layers: `bind`, per-operation `request`, and `close`.
- Keep the spike independent of Pi message/task semantics and do not implement the production messaging layer, broker, daemon, or external service.

## Capabilities

### New Capabilities

- `local-ipc-transport`: Cross-platform local endpoint behavior, framing, deadlines, lifecycle, limits, and the transport boundary used by later Pi-to-Pi layers.

### Modified Capabilities

- None.

## Impact

- Adds spike fixtures/tests and a transport ADR/design record under the repository's test and OpenSpec planning areas.
- Establishes constraints for the future transport implementation without adding production runtime dependencies.
- Provides the contract needed by later discovery, routing, and Pi-integration changes.
