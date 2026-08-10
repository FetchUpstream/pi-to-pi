## 1. Normalize Agent Card and lease contracts

- [x] 1.1 Restore the canonical room and Agent Card validation seams used by the existing tests, including full UUID runtime identities, `r1-` room IDs, safe storage keys, and endpoint/runtime identity equality.
- [x] 1.2 Make `src/discovery/lease.ts` the single source for the 90-second TTL, 30-second renewal interval, expiry helpers, and injectable lease scheduling; update Agent Card and compatibility exports to import or re-export those values instead of defining duplicates.
- [x] 1.3 Convert Agent Card lease construction and validation to ISO-8601 timestamps while keeping internal clock comparisons numeric and deriving abandoned-temp/stale thresholds from the canonical TTL.

## 2. Implement the Agent Card registry boundary

- [x] 2.1 Add the high-level Agent Card registry module over `src/discovery/filesystem.ts` for private tree setup, validated atomic publication, serialized owner renewal/metadata updates, and exact-owner removal.
- [x] 2.2 Add the discovery room adapter that maps a canonical resolved room to `{ roomId, storageKey }` without using raw project/path input, and maps `runtimeId` to the identical full `runtimeInstanceId`.
- [x] 2.3 Implement room-scoped live-card listing that scans only final card files, validates each candidate independently, filters expired/cross-room/mismatched cards, and maps valid cards to the existing lookup peer shape and published network name.
- [x] 2.4 Implement bounded stale-card and abandoned-temporary cleanup with two-TTL eligibility, entry/time limits, exact identity checks, and compare-and-delete revalidation under the existing filesystem lock.

## 3. Isolate compatibility behavior

- [x] 3.1 Mark `RuntimeRecord`/`RuntimeRegistry` as a deprecated compatibility seam, keep its current callers functional, and document P2P-013 as the lifecycle wiring and removal point.
- [x] 3.2 Ensure new Agent Card registry and lookup paths never dual-write, read, or extend the legacy `RuntimeRecord` schema, without modifying lifecycle, transport, router, or Pi-tool ownership.

## 4. Add focused verification

- [x] 4.1 Update Agent Card unit fixtures and tests for canonical UUID/room identities, ISO lease fields, 90/30 defaults, endpoint binding, malformed records, cross-room isolation, and metadata-only payloads.
- [x] 4.2 Add unit coverage for Agent Card registry publication, renewal serialization, live listing, duplicate display-name mapping, exact-owner removal, stale grace-period cleanup, and renewed-card cleanup races.
- [x] 4.3 Add process coverage for concurrent runtimes, replacement runtimes, atomic reads, stale/temp cleanup bounds, and the guarantee that an old owner cannot remove a replacement card.
- [x] 4.4 Run the targeted Agent Card, lease, lookup, and process tests plus the repository typecheck; resolve failures without expanding into P2P-013 lifecycle integration.
