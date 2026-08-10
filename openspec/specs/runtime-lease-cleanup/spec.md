# Runtime Lease Cleanup

## Purpose

TBD — define runtime-keyed registry leases and safe lifecycle cleanup.

## Requirements

### Requirement: Runtime-keyed lease records
The registry MUST key each runtime record by the full runtime UUID and MUST store the room, normalized network name, endpoint, and lease expiry in the record.

#### Scenario: Two runtimes share a display base
- **WHEN** two runtimes publish the same normalized base name in one room
- **THEN** they create separate records keyed by different runtime UUIDs

#### Scenario: Replacement runtime starts
- **WHEN** a replacement runtime starts before an old record has expired
- **THEN** it creates a distinct record and never overwrites the old runtime's record

### Requirement: Lease renewal and expiry
A live runtime MUST renew its own lease periodically, and discovery MUST ignore records whose lease expiry has passed.

#### Scenario: Live record is renewed
- **WHEN** the runtime's renewal interval elapses
- **THEN** only its own record is atomically refreshed with a later expiry

#### Scenario: Crashed record expires
- **WHEN** a runtime stops without running shutdown cleanup and its lease expiry passes
- **THEN** discovery excludes the record from peer results and may garbage-collect it

### Requirement: Exact shutdown cleanup
Normal shutdown MUST remove only the current runtime's record and MUST be idempotent.

#### Scenario: Current runtime shuts down
- **WHEN** Pi emits `session_shutdown`
- **THEN** the runtime closes its resources and removes its exact runtime-keyed record

#### Scenario: Cleanup races with replacement
- **WHEN** an old runtime performs delayed cleanup after a replacement has registered
- **THEN** the old cleanup cannot remove the replacement record because the runtime keys differ

### Requirement: Safe stale-record probing
The registry MUST use lease expiry as the authoritative stale-record rule. A definitive missing-endpoint failure MAY remove the exact still-matching record, but a connection timeout MUST NOT immediately delete an unexpired record.

#### Scenario: Endpoint is definitively absent
- **WHEN** a peer lookup receives a missing-endpoint or connection-refused result for an unexpired record
- **THEN** the implementation may remove that exact unchanged record and report the target unavailable

#### Scenario: Endpoint only times out
- **WHEN** a peer lookup times out while the record is still unexpired
- **THEN** the implementation leaves the record available until a later successful renewal or lease expiry

### Requirement: Atomic registry publication
Lease records MUST be written through a unique temporary file followed by an atomic rename, and cleanup MUST verify the exact runtime key before removal.

#### Scenario: Concurrent renewals occur
- **WHEN** multiple runtimes renew records in the same room
- **THEN** each runtime's complete record is visible atomically without truncating another runtime's record

#### Scenario: Malformed or replaced record is encountered
- **WHEN** cleanup observes a missing, malformed, or changed record
- **THEN** it skips that record rather than deleting an unrelated runtime record
