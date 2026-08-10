## 1. Define the adapter presentation boundary

- [x] 1.1 Add typed self/remote peer discovery view models in `src/pi/adapter.ts` or a focused adjacent module.
- [x] 1.2 Partition registry results using exact canonical comparison with `MessageRouter.runtimeId`, preserving raw records for target resolution.
- [x] 1.3 Project only display name, published target, meaningful state/load, optional model identity, and ambiguity-required runtime IDs.

## 2. Implement compact model-facing output

- [x] 2.1 Replace full Agent Card JSON serialization in `p2p_peers` with deterministic compact text identifying `You`/self and remote peers.
- [x] 2.2 Omit endpoint paths, endpoint runtime IDs, leases, capabilities, nulls, and uninformative zero/default fields.
- [x] 2.3 Include full runtime IDs only when duplicate display/lookup names require disambiguation, while retaining published targets for unique peers.

## 3. Preserve routing behavior

- [x] 3.1 Verify each target rendered by `p2p_peers` resolves through the existing exact-room `resolvePeerTarget()` path.
- [x] 3.2 Confirm `p2p_send` continues routing by the resolved full runtime ID and retains full-ID and ambiguity error behavior.
- [x] 3.3 Avoid changes to Agent Card persistence, room isolation, router protocols, transport endpoints, and lifecycle composition.

## 4. Update and extend tests

- [x] 4.1 Update adapter tests for the new self-aware projection and compact tool output.
- [x] 4.2 Add self-filtering tests covering identical names with distinct runtime IDs and two/three/many runtime rooms.
- [x] 4.3 Add tests for idle, busy, draining, non-zero queue depth, model identity, and omitted defaults/nulls.
- [x] 4.4 Add target round-trip and ambiguity tests proving displayed targets remain sendable and ambiguous names expose full runtime IDs.
- [x] 4.5 Add a many-peer size assertion showing compact output is materially smaller than full Agent Card-derived JSON.

## 5. Verify the change

- [x] 5.1 Run targeted adapter and production-runtime tests.
- [x] 5.2 Run typecheck, lint, and formatting checks; fix any regressions.
