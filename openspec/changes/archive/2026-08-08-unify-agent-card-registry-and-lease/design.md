## Context

P2P-005 already defines the desired Agent Card schema and private filesystem primitives, while the merged implementation still has a separate `RuntimeRecord`/`RuntimeRegistry` implementation. The two paths disagree on field names (`runtimeId` versus `runtimeInstanceId`), lease representation and defaults, room-path inputs, and ownership boundaries. P2P-008 supplies canonical full runtime UUIDs, exact opaque room IDs, and published display-name conventions, but its `ResolvedRoom` does not yet expose the filesystem storage key needed by the Agent Card primitives.

The change must be useful to the discovery layer without taking ownership of lifecycle wiring, local IPC, protocol task state, routing, or Pi tools. It must preserve private cross-platform filesystem behavior and remain safe under concurrent runtimes, reloads, malformed files, and stale cleanup.

## Goals / Non-Goals

**Goals:**

- Provide one high-level Agent Card registry API over the existing private filesystem operations.
- Make 90 seconds the canonical lease TTL and 30 seconds the canonical renewal interval.
- Keep Agent Card lease timestamps ISO-8601 strings while using injectable numeric clocks internally for deterministic scheduling and cleanup.
- Convert P2P-008 identity/name/room values at one explicit discovery boundary, preserving full UUIDs and exact-room isolation.
- Validate filename identity, card identity, endpoint identity, protocol version, room, size, and lease before publication or discovery.
- Make stale-card and abandoned-temp cleanup bounded and compare-and-delete safe.
- Leave a clear compatibility seam for P2P-013 to switch lifecycle consumers and remove the legacy registry.

**Non-Goals:**

- Do not rewire `src/pi/lifecycle.ts` or delete `RuntimeRegistry` in this change.
- Do not change local IPC framing, transport behavior, protocol task state, router semantics, or Pi-facing tools.
- Do not add endpoint heartbeat polling, capability-token authentication, or message/task persistence.
- Do not migrate or merge legacy `RuntimeRecord` files into Agent Card files; the later integration point owns that transition.

## Decisions

### 1. Put the public registry boundary beside discovery, above filesystem primitives

Add an Agent Card-specific registry module that owns card publication, renewal/update, live room listing, exact-owner removal, and cleanup. It delegates path creation, private permissions, atomic writes, compare-and-delete, and temporary-file cleanup to `src/discovery/filesystem.ts` instead of duplicating those operations. The registry accepts a room storage identity and the current runtime identity, so every write and removal is instance-owned.

**Alternative considered:** Extend `src/discovery/registry.ts` until it can emit both record formats. Rejected because that preserves two schemas and two authorities, and makes P2P-013 harder to reconcile.

### 2. Make `src/discovery/lease.ts` the lease-policy source of truth

The lease module will own the default TTL, renewal interval, expiry calculation, live/expired checks, and injectable scheduling behavior. Agent Card construction imports those defaults and may re-export compatibility names, but it does not define another duration. The filesystem derives abandoned-temp and stale-card thresholds from the canonical TTL rather than literal millisecond expressions. Serialized cards use `new Date(expiry).toISOString()` and validation parses the ISO value back to a finite timestamp.

**Alternative considered:** Keep the Agent Card constants and make the legacy lease module aliases. Rejected because timers and cleanup already depend on the lease module and would continue to invite divergent defaults.

### 3. Use a narrow identity and room adapter

The adapter maps P2P-008's full `runtimeId` to the Agent Card's `runtimeInstanceId` without truncation or replacement. It maps a resolved room to `{ roomId, storageKey }` only after validating the canonical opaque room ID; the storage key is either supplied by the room boundary or derived from that already-safe room ID, never from raw project text or a path. It maps `AgentCard.displayName` to the existing published network-name convention using the same runtime UUID, so duplicate base names remain distinguishable.

Every card write and read validates that the card runtime ID, its `<runtimeInstanceId>.json` filename, and `endpoint.runtimeInstanceId` are identical. A card from another room or with a mismatched endpoint is ignored or rejected, never adapted into a routable peer.

**Alternative considered:** Rename the Agent Card field to `runtimeId` or make lookup understand both shapes everywhere. Rejected because it spreads compatibility aliases through routing code; one adapter keeps each contract's vocabulary local.

### 4. Keep discovery read behavior defensive and lease-authoritative

Room listing scans only final JSON card files, bounds bytes and entries, and independently validates each candidate. Invalid JSON, unsupported versions, invalid identities, cross-room cards, mismatched filenames/endpoints, and expired leases are skipped without hiding valid peers. A healthy runtime is present because it renews its own card; endpoint probing remains an explicit transport/diagnostic operation and cannot be the ordinary stale-record rule.

Shutdown removal and stale cleanup use exact runtime ownership plus a re-read immediately before unlinking. Cleanup only considers cards expired for two additional TTLs and abandons temporary files only after the same derived age; bounded entry and time budgets prevent an untrusted directory from monopolizing the process.

**Alternative considered:** Delete records after any failed endpoint connection. Rejected because a timeout is not proof of stale ownership and would let transient transport failures erase live peers.

### 5. Isolate the legacy registry rather than partially migrating lifecycle

`RuntimeRecord` and `RuntimeRegistry` remain available only as a documented compatibility seam for current lifecycle tests and consumers. New Agent Card discovery code does not write or read that schema, and `lookup.ts` receives Agent Card-derived peer records through the adapter. P2P-013 will own changing lifecycle construction, removing the remaining legacy exports, and ensuring there is no dual publication.

**Alternative considered:** Modify lifecycle in this change to use the new registry. Rejected because it crosses the explicit P2P-013 ownership boundary and would couple this foundation change to task/lifecycle integration work running in parallel.

## Risks / Trade-offs

- **[Legacy callers continue to observe the old schema during the transition]** → Mark the legacy module as deprecated, keep the compatibility behavior unchanged, and document P2P-013 as the required wiring/removal point.
- **[A cleanup race could remove a renewed card]** → Re-read the candidate under the same per-card/process lock and compare its identity and lease immediately before unlinking.
- **[Name mapping can hide duplicate display names]** → Generate the published name from the full runtime UUID and preserve lookup ambiguity results with full canonical peer addresses.
- **[Clock or timestamp representation drift can make cards appear stale]** → Centralize conversion helpers, inject the clock in tests, and validate ISO timestamps at every filesystem boundary.
- **[Room storage-key integration is not yet part of `ResolvedRoom`]** → Keep the adapter in discovery, accept a supplied storage key when available, and otherwise use only the validated opaque room ID; do not alter room derivation or use raw input as a path.
- **[Large or hostile registry directories can delay cleanup]** → Retain byte limits and enforce entry/time budgets for scans and abandoned-temp cleanup.

## Migration Plan

1. Add the Agent Card registry boundary and canonical lease policy without changing lifecycle construction.
2. Point new discovery/lookup tests and callers at Agent Cards, while leaving legacy `RuntimeRegistry` tests as compatibility coverage.
3. Run unit and multi-process tests for concurrent publication, renewal, malformed files, expiry, replacement, and cleanup races.
4. In P2P-013, switch lifecycle startup/renewal/shutdown and peer listing to this boundary, then remove the legacy registry path once no callers remain.
5. Rollback before P2P-013 is non-destructive: stop using the new boundary and retain the existing legacy implementation. No persisted legacy files are rewritten by this change.

## Open Questions

- P2P-013 must choose the final lifecycle factory/export wiring and the exact point at which deprecated `RuntimeRegistry` symbols can be removed.
- P2P-013 and the room owner should decide whether `ResolvedRoom` eventually exposes `storageKey` directly; the discovery adapter keeps that decision out of this change.
