## ADDED Requirements

### Requirement: Active production cards SHALL reflect one ready runtime
A production runtime SHALL publish one canonical Agent Card only after its native endpoint and inbound request handler are ready. That card and `peer.describe` SHALL represent the same session ID, runtime instance ID, exact room, endpoint kind/address, effective protocol capabilities, and maximum message size. The advertised maximum SHALL not exceed the effective minimum of router/protocol and transport payload limits.

#### Scenario: Published endpoint and capability limit are usable
- **WHEN** a runtime becomes discoverable through the production lifecycle
- **THEN** its card identifies its bound endpoint and advertises a maximum message size no greater than the active transport and router limits

### Requirement: Production card metadata SHALL follow live Pi and router state
The active runtime SHALL update its canonical Agent Card for display-name changes, available model/provider, busy/idle/draining state, available context usage, and inbound queue depth without changing runtime identity. These presence updates SHALL NOT terminalize Pi-to-Pi tasks or create a second discovery card.

#### Scenario: Runtime becomes busy and is renamed
- **WHEN** Pi reports agent activity and later a session information name change
- **THEN** the same live Agent Card updates its state and display name while retaining its runtime instance ID and endpoint
