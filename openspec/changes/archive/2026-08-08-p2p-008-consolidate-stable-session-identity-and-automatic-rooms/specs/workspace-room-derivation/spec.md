## MODIFIED Requirements

### Requirement: Room input normalization and opaque IDs
The extension MUST normalize explicit project labels, validate them, and derive a versioned opaque `roomId` from a source discriminator and normalized value. The canonical room identity MUST be the validated `roomId`; raw project labels, filesystem paths, legacy room IDs, and other user-controlled strings MUST NOT be used directly as registry directory names or machine room addresses.

#### Scenario: Explicit room ID is derived
- **WHEN** a valid explicit project label is provided
- **THEN** the room ID is deterministic, begins with `r1-`, contains only the permitted safe hash characters, and is identical for peers using the same normalized label

#### Scenario: Invalid explicit project is supplied
- **WHEN** a project label is empty after normalization or contains a Unicode control or format character (`Cc`/`Cf`)
- **THEN** startup rejects the configuration rather than selecting a global default room

#### Scenario: Raw room input reaches a path boundary
- **WHEN** a raw project label, working-directory string, or legacy room value is supplied where a registry path component or machine room identity is required
- **THEN** the boundary rejects it or requires the already validated opaque `roomId`

### Requirement: Exact room isolation
A runtime MUST belong to one resolved opaque room, and discovery and protocol target validation MUST require exact equality of canonical `roomId` values without cross-room fallback.

#### Scenario: Cross-room target is supplied
- **WHEN** a caller supplies a valid runtime address belonging to another room
- **THEN** resolution rejects the target as cross-room and does not open its endpoint

#### Scenario: Legacy room shape is supplied
- **WHEN** a legacy room object or non-canonical room field is supplied to a new room or lookup boundary
- **THEN** the boundary does not silently reinterpret it as the canonical room; any supported conversion occurs only in an explicit compatibility adapter

## ADDED Requirements

### Requirement: Canonical resolved-room representation
Automatic room resolution MUST return one canonical resolved-room shape containing `roomId`, the canonical source discriminator (`explicit`, `git`, or `cwd`), and the normalized/canonical derivation value. New consumers MUST use `roomId` rather than a legacy `id` field.

#### Scenario: Room resolution completes
- **WHEN** explicit, Git, or cwd resolution selects a room
- **THEN** the result exposes the opaque `roomId` and one canonical source value without a global default room

#### Scenario: Room identity is passed between modules
- **WHEN** a resolved room crosses an identity, naming, lookup, or discovery boundary
- **THEN** the receiving module consumes `roomId` and does not require a duplicate legacy room model
