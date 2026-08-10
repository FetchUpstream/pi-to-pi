## 1. Production wire and binding bridge

- [x] 1.1 Add a bounded UTF-8 JSON codec for protocol envelopes and operation responses using the effective router/transport payload limit.
- [x] 1.2 Implement the inbound IPC handler that decodes requests, validates live same-room Agent Card binding identity, routes through `MessageRouter.processInbound`, and encodes correlated responses.
- [x] 1.3 Implement concrete `OutboundDelivery` that resolves exact live Agent Card endpoints, exchanges IPC bytes, hands valid responses to its originating router, and maps failures to bounded protocol errors.
- [x] 1.4 Add focused codec and bridge tests for successful correlation, malformed/oversized payloads, stale/cross-room binding, peer disappearance, and concurrent responses.

## 2. Runtime composition and default extension wiring

- [x] 2.1 Add a runtime-scoped production composition owner for identity, room/name, generated endpoint, bound transport, Agent Card registry, router, Pi adapter, and immutable generation.
- [x] 2.2 Start composition in bind-before-publish order and derive canonical Agent Card capabilities and maximum message size from active router and transport limits.
- [x] 2.3 Replace the active lifecycle `RuntimeRegistry`/`unbound:<runtimeId>` path with the composition and retain legacy exports only as unreachable compatibility seams.
- [x] 2.4 Register the four tools through a stable runtime-aware dispatcher so the default export works without injected components while retaining narrow test seams.
- [x] 2.5 Add lifecycle/default-export tests proving side-effect-free factory evaluation, bound-card publication, self-wired tools, exact-room routing, and no legacy active publication.

## 3. Presence and generation-safe lifecycle

- [x] 3.1 Project session name, model/provider, busy/idle/draining state, context usage, and router queue depth onto the single canonical Agent Card.
- [x] 3.2 Fence adapter task execution and terminal completion delivery by the originating composition generation, session, and runtime identity.
- [x] 3.3 Implement idempotent runtime shutdown that fences delivery, closes router, removes the exact card, closes the owned transport, and releases identity without affecting replacements.
- [x] 3.4 Add focused replacement tests for reload/new/resume/fork, old callback suppression, old card/endpoint cleanup races, repeated shutdown, and metadata updates without identity changes.

## 4. Production end-to-end proof

- [x] 4.1 Extend existing Pi fixtures to compose real production transport, registry, router, adapter, and default extension instances without duplicate fakes.
- [x] 4.2 Add two-peer end-to-end tests for discovery, request admission, explicit reply, one correlated follow-up, reverse-order concurrent replies, and duplicate request suppression.
- [x] 4.3 Add three-peer nested-request, same-name ambiguity, cross-room isolation, stale-runtime, unreachable-peer, malformed-input, cancellation/expiry, and invalid structured-reply coverage.
- [x] 4.4 Run the targeted integration/process suites and the repository cross-platform-compatible validation required by the project scripts.
