## 1. Establish the production transport boundary

- [x] 1.1 Define the transport-only payload, handler, request-options, bound-server, lifecycle, and typed-error contracts in `src/transport/transport.ts` without importing protocol, router, discovery, identity, room, or Pi modules.
- [x] 1.2 Add production endpoint generation and validation under `src/transport/`, including distinct short runtime identifiers, POSIX UTF-8 byte limits, and Windows named-pipe address handling.
- [x] 1.3 Implement one reusable four-byte unsigned big-endian frame codec with incremental stream decoding, pre-allocation maximum checks, truncation detection, and trailing-data rejection.

## 2. Implement the bounded local IPC lifecycle

- [x] 2.1 Implement native `node:net` bind/listen and connect behavior for POSIX Unix sockets and Windows named pipes, with no TCP fallback and tracked active sockets.
- [x] 2.2 Implement one-operation client request/response flow for opaque byte payloads, including partial/coalesced stream handling, write callbacks, backpressure, response association, and peer-close errors.
- [x] 2.3 Implement server-side request decoding, single handler dispatch, bounded response encoding, response write completion, and forced connection close after one exchange.
- [x] 2.4 Implement validated absolute connect, write, read, shutdown, and overall-operation deadlines, including silent-peer and slow-drip protection without inactivity-only timeout behavior.
- [x] 2.5 Implement `AbortSignal` cancellation and idempotent close so sockets, listeners, timers, handlers, and owned endpoints are released on every success and failure path.
- [x] 2.6 Implement conservative POSIX stale-endpoint recovery with generated-path ownership checks, live/stale/inconclusive probes, identity-safe quarantine and replacement preservation; keep Windows pipe cleanup OS-managed.

## 3. Add focused in-process transport coverage

- [x] 3.1 Test frame encoding/decoding across split headers, split bodies, coalesced chunks, opaque binary data, oversized declarations, truncation, and trailing bytes.
- [x] 3.2 Test endpoint generation, UTF-8 byte-length boundaries, deep-working-directory isolation, concurrent uniqueness, POSIX endpoint ownership, and Windows pipe address shape.
- [x] 3.3 Test bind/request/close lifecycle, concurrent response association, backpressure, peer exit, malformed and oversized frames, silent peers, slow-drip deadlines, abort cleanup, and repeated shutdown.
- [x] 3.4 Test that transport code exposes no JSON/Pi/task semantics and does not open a TCP fallback.

## 4. Prove independent-process behavior with the existing harness

- [x] 4.1 Add only the transport-specific child-fixture behavior needed for opaque bind/request exchanges and run it through `tests/support/index.ts`, managed process groups, isolated workspaces, bounded waits, diagnostics, and cleanup.
- [x] 4.2 Add a two-process test exchanging multiple framed payloads and verify clean endpoint/process teardown.
- [x] 4.3 Add concurrent multi-process requests with deliberately varied response timing and verify that responses never cross-wire.
- [x] 4.4 Add process-level silent-peer, slow-drip header/body, malformed/truncated/oversized frame, peer-exit, caller-abort, and bounded-deadline scenarios.
- [x] 4.5 Add process-level stale endpoint scenarios proving that live, inconclusive, timed-out, and replacement endpoints are never blindly removed.
- [x] 4.6 Run the focused production transport suite on native Linux, macOS, and Windows CI and retain the actual platform results; do not infer unavailable platform evidence from Linux (GitHub Actions run 31372925578).

## 5. Verify scope and repository integration

- [x] 5.1 Run targeted transport tests, type checking, linting, formatting, and build checks for the production transport changes.
- [x] 5.2 Run the repository's existing validation suite and confirm the cross-platform CI matrix exercises the new production tests without adding dependencies or a second process framework (GitHub Actions run 31372925578).
- [x] 5.3 Confirm the final diff is limited to `src/transport/*`, focused transport tests, narrowly necessary test-fixture documentation, and an approved compatibility-only room identity export fix required by the pre-existing repository validation suite; leave room derivation semantics, protocol, router, discovery, Pi, and runtime-integration ownership untouched.
