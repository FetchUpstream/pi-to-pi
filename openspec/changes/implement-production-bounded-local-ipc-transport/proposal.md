## Why

Pi-to-Pi has an accepted local-IPC framing decision and a reusable cross-platform process-test harness, but `src/transport/` still contains only placeholders. The production transport must turn the Linux-only spike evidence into a bounded, protocol-agnostic implementation and prove the native Unix-domain socket and Windows named-pipe behavior required by the project.

## What Changes

- Implement the selected four-byte big-endian length-prefixed byte transport in `src/transport/` using Node's path-based `node:net` API.
- Support Unix-domain sockets on Linux/macOS and named pipes on Windows without a TCP fallback.
- Provide endpoint bind/listen, one-operation request/response, bounded opaque byte frames, and idempotent close lifecycle.
- Enforce maximum frame sizes, partial-stream handling, backpressure, malformed/truncated/trailing-frame rejection, peer-exit handling, absolute phase deadlines, an overall operation bound, and `AbortSignal` cancellation.
- Generate short platform-appropriate endpoints and perform conservative, ownership-safe stale POSIX endpoint cleanup.
- Add focused production transport tests, including multi-process Linux/macOS/Windows coverage using the existing process harness.
- Keep all Pi protocol, task, room, identity, discovery, routing, and tool semantics outside the transport boundary.

## Capabilities

### New Capabilities

None. The production implementation fulfills the existing local IPC transport capability.

### Modified Capabilities

- `local-ipc-transport`: Make the existing framing, endpoint, bounded-lifecycle, cancellation, cleanup, and cross-platform requirements explicit for the production transport, including an overall operation deadline and native platform validation.

## Impact

- Adds production code under `src/transport/` and focused transport/process tests.
- Reuses `tests/support/` managed-process helpers and the existing Linux/macOS/Windows CI matrix.
- Does not add dependencies or alter protocol, router, discovery, room-derivation, Pi lifecycle/tool, or final runtime-integration modules; it restores only the pre-existing room identity validation exports needed for repository validation.
- The later integration issue will connect this transport to the runtime; this change only establishes the transport boundary and its evidence.
