## Why

The repository currently has two overlapping discovery models: the richer, versioned Agent Card filesystem contract and a legacy `RuntimeRecord`/`RuntimeRegistry` path used by lifecycle and lookup code. Their schemas, roots, identity names, and lease defaults diverge, so discovery can expose inconsistent data and cleanup behavior before the later end-to-end reconciliation in P2P-013. This change makes the Agent Card contract the single discovery authority and gives it one canonical lease and registry API.

## What Changes

- Implement an `AgentCardRegistry` boundary over the existing Agent Card filesystem primitives for publication, renewal/metadata updates, room-scoped live listing, exact-owner removal, and bounded stale/temp cleanup.
- Make the accepted 90-second lease TTL and 30-second renewal interval canonical, and derive expiry, stale-record, and temporary-file age decisions from that contract.
- Use ISO timestamps for Agent Card lease fields and validate that card identity, filename ownership, and endpoint runtime identity agree.
- Add explicit adapters between P2P-008's `runtimeId`/room resolution vocabulary and the Agent Card `runtimeInstanceId`/`storageKey` vocabulary; preserve full UUID and exact-room routing semantics.
- Isolate and deprecate the legacy `RuntimeRecord`/`RuntimeRegistry` implementation as a compatibility seam, documenting P2P-013 as the point where lifecycle wiring and eventual removal are reconciled.
- Add focused unit and process coverage for canonical cards, leases, ownership-safe cleanup, malformed/cross-room records, duplicate display names, and concurrent runtimes.
- Keep lifecycle, transport, protocol-router, and Pi-tool ownership unchanged in this change.

## Capabilities

### New Capabilities

<!-- No new discovery model is introduced; this change consolidates existing capabilities. -->

### Modified Capabilities

- `agent-card-registry`: Make the existing Agent Card filesystem contract the implemented registry authority, with canonical lease timing, identity adapters, endpoint/runtime binding, and the single public registry API.
- `runtime-lease-cleanup`: Reconcile legacy runtime-keyed lease behavior with Agent Card records and make stale cleanup, exact ownership, and lease timing use the Agent Card contract rather than a parallel `RuntimeRecord` store.

## Impact

- Affects `src/protocol/agent-card.ts`, `src/protocol/validation.ts`, `src/discovery/filesystem.ts`, `src/discovery/lease.ts`, `src/discovery/lookup.ts`, and the new/updated Agent Card registry boundary.
- Isolates `src/discovery/registry.ts` and its `RuntimeRecord` schema for the P2P-013 integration/removal point instead of extending it with more discovery behavior.
- Requires narrow integration with the existing identity and room modules, including canonical full runtime UUIDs, exact room IDs, and the room-provided filesystem `storageKey`.
- Adds targeted unit/process verification without changing local IPC transport, protocol task state, router behavior, lifecycle ownership, or Pi tools.
- Introduces no external runtime dependency and does not persist message or task bodies in discovery records.
