## ADDED Requirements

### Requirement: The legacy lease registry SHALL be isolated from Agent Card authority

The existing `RuntimeRecord` and `RuntimeRegistry` implementation SHALL be treated as a deprecated compatibility seam until P2P-013 completes lifecycle reconciliation. The Agent Card registry SHALL not delegate to it, dual-write it, or use its files as discovery input. P2P-013 SHALL be the migration point for replacing remaining lifecycle consumers and removing the seam.

#### Scenario: Agent Card operations avoid the legacy store
- **WHEN** the Agent Card registry publishes, renews, lists, or removes presence
- **THEN** it uses the Agent Card schema and filesystem tree without reading or writing a `RuntimeRecord`

#### Scenario: Legacy removal is deferred to the integration point
- **WHEN** this discovery foundation is used before P2P-013 lifecycle wiring lands
- **THEN** existing compatibility exports may remain available, but no new Agent Card behavior is added to them

## MODIFIED Requirements

### Requirement: Runtime-keyed lease records

The discovery contract MUST represent each live presence record as an Agent Card keyed by the full runtime UUID in `runtimeInstanceId`, and MUST store the canonical room, effective display name, endpoint descriptor, and ISO lease expiry in that card. An explicit boundary adapter MUST expose the same UUID as P2P-008's `runtimeId` when lookup requires that vocabulary. A display name MUST never be used as the record key or ownership identity.

#### Scenario: Two runtimes share a display base
- **WHEN** two runtimes publish the same normalized base name in one room
- **THEN** they create separate Agent Card files keyed by different full runtime instance UUIDs and produce distinct published network names

#### Scenario: Replacement runtime starts
- **WHEN** a replacement runtime starts before an old card has expired
- **THEN** it creates a distinct Agent Card and never overwrites the old runtime's card

### Requirement: Lease renewal and expiry

A live runtime MUST renew its own Agent Card periodically using the canonical 90-second TTL and 30-second renewal interval, and discovery MUST ignore cards whose ISO lease expiry has passed. Lease policy defaults MUST come from one lease module; cleanup and temporary-file age calculations MUST derive from the same TTL.

#### Scenario: Live card is renewed
- **WHEN** the runtime's renewal interval elapses
- **THEN** only its own Agent Card is atomically refreshed with a later valid ISO expiry

#### Scenario: Crashed card expires
- **WHEN** a runtime stops without running shutdown cleanup and its ISO lease expiry passes
- **THEN** discovery excludes the card and does not require a peer probe to decide that it is no longer live

### Requirement: Exact shutdown cleanup

Normal shutdown MUST remove only the current runtime's Agent Card and MUST be idempotent. Removal MUST verify the exact runtime instance, room, and owner identity immediately before unlinking.

#### Scenario: Current runtime shuts down
- **WHEN** Pi emits `session_shutdown`
- **THEN** the runtime closes its resources and removes only its exact Agent Card

#### Scenario: Cleanup races with replacement
- **WHEN** an old runtime performs delayed cleanup after a replacement has registered
- **THEN** the old cleanup cannot remove the replacement card because the runtime instance keys differ

### Requirement: Safe stale-record probing

The Agent Card registry MUST use lease expiry as the authoritative stale-record rule. A definitive missing-endpoint failure MAY remove the exact still-matching expired or owner-validated card only when an explicit diagnostic or transport operation requests that action, but a connection timeout MUST NOT immediately delete an unexpired card. Ordinary discovery MUST NOT perform periodic all-to-all endpoint probing.

#### Scenario: Endpoint is definitively absent
- **WHEN** an explicit probe receives a missing-endpoint or connection-refused result for a card that still matches its full runtime identity
- **THEN** the implementation may remove that exact unchanged card and report the target unavailable

#### Scenario: Endpoint only times out
- **WHEN** a peer lookup times out while the Agent Card is still unexpired
- **THEN** the implementation leaves the card available until a later successful renewal or lease expiry

### Requirement: Atomic registry publication

Agent Cards MUST be written through a unique temporary file followed by an atomic rename, and cleanup MUST re-read and verify the exact runtime instance, room, and lease state before removal. Temporary files older than two canonical TTLs MAY be removed within bounded cleanup limits.

#### Scenario: Concurrent renewals occur
- **WHEN** multiple runtimes renew cards in the same room
- **THEN** each runtime's complete Agent Card is visible atomically without truncating or replacing another runtime's card

#### Scenario: Malformed or replaced card is encountered
- **WHEN** cleanup observes a missing, malformed, renewed, or changed card
- **THEN** it skips that candidate rather than deleting an unrelated runtime card
