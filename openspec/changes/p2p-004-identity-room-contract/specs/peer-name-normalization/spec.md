## ADDED Requirements

### Requirement: Namespaced network-name configuration
The extension MUST expose `--p2p-name` as the explicit network-name override and MUST use it in preference to Pi's native session name.

#### Scenario: Explicit P2P name is supplied
- **WHEN** the runtime starts with `--p2p-name Planner`
- **THEN** the published network name is based on the normalized P2P value and not Pi's session name

#### Scenario: No explicit P2P name is supplied
- **WHEN** the runtime starts without `--p2p-name`
- **THEN** the published network name is based on Pi's current session name, or the `agent` fallback when no session name exists

### Requirement: Canonical lowercase name normalization
The extension MUST normalize a name by applying NFKC normalization, lowercasing, rejecting control characters, retaining Unicode letters and numbers, replacing runs of whitespace/punctuation/symbols with `-`, collapsing repeated hyphens, trimming hyphens, and enforcing a maximum of 48 Unicode code points.

#### Scenario: Mixed-case and symbols are normalized
- **WHEN** a name contains uppercase letters, whitespace, punctuation, or symbols
- **THEN** the published base name is lowercase, hyphen-separated, and contains no unnormalized symbol runs

#### Scenario: Explicit name has no valid content
- **WHEN** an explicitly supplied P2P name becomes empty after normalization
- **THEN** startup rejects the invalid configuration

#### Scenario: No name is configured
- **WHEN** neither `--p2p-name` nor a Pi session name is available
- **THEN** the normalized base name is `agent`

### Requirement: Runtime-derived four-character suffix
The published network name MUST append a four-character lowercase Crockford-base32 suffix derived from the runtime UUID's SHA-256 digest.

#### Scenario: Runtime name is published
- **WHEN** the normalized base name is `planner` and the runtime suffix is `k7q2`
- **THEN** the published name is `planner-k7q2`

#### Scenario: Runtime is replaced
- **WHEN** a new runtime starts for a reload or session replacement
- **THEN** it receives a newly derived suffix even if the base name and logical session are unchanged

### Requirement: Session-name synchronization
When no `--p2p-name` override is configured, the extension MUST read Pi's name at startup and update the published base name on `session_info_changed` without changing the runtime ID, session ID, room, or endpoint.

#### Scenario: Pi session is renamed
- **WHEN** Pi emits `session_info_changed` with a new name
- **THEN** the registry publishes the newly normalized base with the current runtime's unchanged suffix

#### Scenario: Explicit override remains active
- **WHEN** Pi emits a session-name change while `--p2p-name` is configured
- **THEN** the published network name remains based on the explicit P2P name

### Requirement: Collision-safe peer resolution
The extension MUST treat the full runtime UUID as the canonical address and MUST return all candidate addresses when a normalized network name matches multiple live records.

#### Scenario: Duplicate normalized names exist
- **WHEN** two peers resolve to the same published name or suffix collision
- **THEN** name-based resolution fails with the candidate full runtime addresses and does not choose or silently rename a peer

#### Scenario: Full runtime address is supplied
- **WHEN** a caller supplies a full runtime UUID
- **THEN** resolution addresses that exact runtime, subject to exact room validation
