## MODIFIED Requirements

### Requirement: Ephemeral runtime identity
The P2P extension MUST create one fresh `RuntimeId` for every started extension runtime and MUST NOT restore it from Pi session data. The internal runtime identifier MUST be a full canonical lowercase UUID; shortened or display-derived identifiers MUST NOT be accepted as runtime identities.

#### Scenario: Runtime starts
- **WHEN** Pi emits `session_start`
- **THEN** the extension creates one fresh full UUID runtime ID for that runtime and uses that canonical `RuntimeId` for registry ownership

#### Scenario: Runtime replacement cannot reuse identity
- **WHEN** an old runtime is replaced by reload, session replacement, process restart, or shutdown/startup
- **THEN** the replacement runtime has a different full runtime UUID even when the logical session ID is unchanged

#### Scenario: Short runtime values are rejected
- **WHEN** a caller supplies a shortened, non-UUID, uppercase, or otherwise non-canonical runtime value at an identity boundary
- **THEN** validation rejects it rather than branding or routing it as a `RuntimeId`

### Requirement: Runtime address is authoritative
The full canonical runtime UUID MUST be the machine-actionable peer target. The canonical internal peer address MUST contain that `runtimeId` together with the exact opaque `roomId`. Session IDs, display names, and shortened suffixes MUST NOT be used as endpoint ownership or routing identities. External schemas that use a different runtime field name MUST be adapted explicitly at their boundary.

#### Scenario: Route to a peer
- **WHEN** a protocol operation targets a peer
- **THEN** the target identifies the peer's full runtime UUID and exact room through the canonical peer-address shape

#### Scenario: External runtime field is adapted
- **WHEN** an external discovery schema represents the same runtime as `runtimeInstanceId`
- **THEN** an explicit adapter validates and maps that field to the internal `runtimeId` without creating a second runtime identity model

#### Scenario: Old runtime record remains
- **WHEN** an old runtime record is still present while a replacement runtime is active
- **THEN** an operation addressed to the old full runtime UUID cannot be routed to the replacement runtime

## ADDED Requirements

### Requirement: Canonical identity vocabulary
Internal identity, discovery, and pure address-resolution contracts MUST use `sessionId`, `runtimeId`, and `roomId` consistently. Compatibility aliases MAY exist only in isolated external adapters and MUST NOT be used by new internal routing code.

#### Scenario: Internal routing fields are inspected
- **WHEN** a runtime identity or peer address crosses an internal routing boundary
- **THEN** its machine identity is represented by the canonical `runtimeId` field and its room by the canonical `roomId` field

#### Scenario: Display identity is supplied for routing
- **WHEN** a caller supplies a session ID, display name, or shortened runtime suffix where a runtime address is required
- **THEN** the boundary rejects the value instead of treating it as a machine route
