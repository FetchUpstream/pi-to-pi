## Why

The current extension scaffold proves only that Pi can load the package and register basic lifecycle hooks. Before implementing peer routing, Pi-to-Pi needs an executable contract for lifecycle boundaries, busy-agent delivery, retries/compaction, and request/reply correlation; otherwise a reply can be attributed to the wrong inbound request or the wrong session.

## What Changes

- Add deterministic in-process fixture tests against the current Pi extension API.
- Verify lifecycle ordering and cleanup for startup, reload, new, resume, fork, clone, and shutdown.
- Verify idle, busy-steer, and busy-follow-up custom-message delivery, including preservation of request IDs in `details`.
- Verify that `agent_settled`, not `agent_end`, is the request-completion boundary.
- Define explicit request-scoped reply correlation and session-scoped task metadata recovery.
- Persist only task metadata needed for reload recovery; do not duplicate message bodies.
- Record the resulting guarantees in a Pi integration ADR/test report.
- Keep production transport, discovery, routing, and cross-process behavior out of scope.

## Capabilities

### New Capabilities

- `pi-session-lifecycle`: Deterministic lifecycle, session replacement, cleanup, and session-name synchronization behavior for the Pi adapter.
- `correlated-inbound-delivery`: Request-scoped custom-message delivery and explicit reply correlation across idle and busy agents.
- `task-state-recovery`: Minimal persisted task metadata and recovery rules across reload and session replacement.

### Modified Capabilities

<!-- No existing OpenSpec capabilities are present; this change introduces the contracts above. -->

## Impact

- Adds focused unit/integration fixture coverage under `tests/` and supporting test utilities as needed.
- Documents the tested contract in `docs/adr/0001-pi-lifecycle-and-reply-correlation.md`.
- Uses the existing `@earendil-works/pi-coding-agent` development dependency and its in-process SDK fixture APIs.
- Does not change the public transport or peer-messaging implementation, which remains a later wave.
