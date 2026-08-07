## ADDED Requirements

### Requirement: Namespaced explicit project configuration
The extension MUST expose `--p2p-project` as an explicit project-room label and MUST give it precedence over automatic room derivation.

#### Scenario: Explicit project is supplied
- **WHEN** the runtime starts with `--p2p-project frontend`
- **THEN** the runtime joins the room derived from the normalized `frontend` label regardless of its Git repository or working directory

#### Scenario: Different explicit projects are isolated
- **WHEN** two runtimes use different normalized project labels
- **THEN** they do not discover or address one another through default P2P resolution

### Requirement: Room input normalization and opaque IDs
The extension MUST normalize explicit project labels, validate them, and derive a versioned opaque room ID from a source discriminator and normalized value. Raw project labels and filesystem paths MUST NOT be used directly as registry directory names.

#### Scenario: Explicit room ID is derived
- **WHEN** a valid explicit project label is provided
- **THEN** the room ID is deterministic, begins with `r1-`, contains only the permitted safe hash characters, and is identical for peers using the same normalized label

#### Scenario: Invalid explicit project is supplied
- **WHEN** a project label is empty after normalization or contains a Unicode control or format character (`Cc`/`Cf`)
- **THEN** startup rejects the configuration rather than selecting a global default room

### Requirement: Git common-directory derivation
When no explicit project is configured and the working directory is inside a Git repository, the extension MUST derive the room from the canonical Git common directory rather than the individual worktree directory.

#### Scenario: Multiple worktrees share a room
- **WHEN** two runtimes run in separate worktrees of the same Git repository without explicit projects
- **THEN** they derive the same room ID

#### Scenario: Different repositories remain isolated
- **WHEN** two runtimes run in unrelated Git repositories without explicit projects
- **THEN** they derive different room IDs

### Requirement: Working-directory fallback
When no explicit project is configured and Git common-directory discovery fails, the extension MUST derive the room from the canonical working directory.

#### Scenario: Non-Git directories use their own rooms
- **WHEN** two runtimes run in different canonical non-Git directories
- **THEN** they derive different room IDs

#### Scenario: Equivalent directory spellings converge
- **WHEN** two runtimes refer to the same existing directory through equivalent path spellings or symlinks
- **THEN** they derive the same canonical working-directory room ID

### Requirement: Exact room isolation
A runtime MUST belong to one resolved room, and discovery and protocol target validation MUST require exact room equality without cross-room fallback.

#### Scenario: Cross-room target is supplied
- **WHEN** a caller supplies a valid runtime address belonging to another room
- **THEN** resolution rejects the target as cross-room and does not open its endpoint
