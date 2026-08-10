## MODIFIED Requirements

### Requirement: Namespaced network-name configuration
The extension MUST expose `--p2p-name` as the explicit network-name override. Without that override, Pi's native session name MUST remain the primary human-facing name source, with the documented `agent` fallback when no usable native name exists.

#### Scenario: Explicit P2P name is supplied
- **WHEN** the runtime starts with `--p2p-name Planner`
- **THEN** the published network name is based on the normalized explicit value and not Pi's session name

#### Scenario: No explicit P2P name is supplied
- **WHEN** the runtime starts without `--p2p-name`
- **THEN** the published network name is based on Pi's current session name, or the `agent` fallback when no usable session name exists

### Requirement: Runtime-derived four-character suffix
The published network name MUST append a four-character lowercase Crockford-base32 suffix derived from the full runtime UUID's SHA-256 digest. The suffix MUST remain display- and lookup-only and MUST NOT become a routing identifier.

#### Scenario: Runtime name is published
- **WHEN** the normalized base name is `planner` and the runtime suffix is `k7q2`
- **THEN** the published name is `planner-k7q2` and the full runtime UUID remains the machine address

#### Scenario: Runtime is replaced
- **WHEN** a new runtime starts for a reload or session replacement
- **THEN** it receives a newly derived suffix even if the base name and logical session are unchanged

#### Scenario: Suffix is used as a route
- **WHEN** a caller supplies only a four-character suffix or other shortened name at a machine-routing boundary
- **THEN** the boundary rejects it as a runtime address and requires the full runtime UUID

### Requirement: Session-name synchronization
When no `--p2p-name` override is configured, the extension MUST read Pi's name at startup and update the normalized display base and derived published name on `session_info_changed` without changing the runtime ID, session ID, room, endpoint, or runtime suffix.

#### Scenario: Pi session is renamed
- **WHEN** Pi emits `session_info_changed` with a new name
- **THEN** the registry publishes the newly normalized base with the current runtime's unchanged suffix and full runtime identity

#### Scenario: Explicit override remains active
- **WHEN** Pi emits a session-name change while `--p2p-name` is configured
- **THEN** the published network name remains based on the explicit P2P name

### Requirement: Collision-safe peer resolution
The extension MUST treat the full runtime UUID together with the exact room as the canonical peer address and MUST return every candidate full address when a normalized human-facing or published network name matches multiple live records.

#### Scenario: Duplicate normalized names exist
- **WHEN** two peers resolve to the same published name or suffix collision
- **THEN** name-based resolution fails with all candidate full runtime addresses and does not choose or silently rename a peer

#### Scenario: Full runtime address is supplied
- **WHEN** a caller supplies a full canonical runtime UUID
- **THEN** resolution addresses that exact runtime, subject to exact room validation

## ADDED Requirements

### Requirement: Display and published names are distinct
The pure naming contracts MUST represent the normalized human-facing base as a `NormalizedName` and the suffix-qualified lookup value as a `PublishedNetworkName`. A canonical field MUST NOT ambiguously accept either representation.

#### Scenario: Name state is constructed
- **WHEN** a runtime name is created
- **THEN** the normalized display base and suffix-qualified published name are available as distinct values derived from the same full runtime identity

#### Scenario: External display metadata is resolved
- **WHEN** discovery supplies a normalized display name and a full runtime identity
- **THEN** the lookup boundary derives the published network name explicitly rather than routing on the display name alone
