## MODIFIED Requirements

### Requirement: Pi SHALL present and resolve live Agent Card peers safely
`p2p_peers` SHALL use the production `AgentCardRegistry` live peer boundary for the current exact room. Its model-facing result SHALL explicitly identify the local runtime by exact comparison with the active router runtime ID and SHALL exclude that runtime from the remote peer collection. For each normal remote peer it SHALL expose only a display name, collision-resistant published target, meaningful state/load, and useful model identity when available; it SHALL omit endpoint/address, lease data, protocol capabilities, null values, and uninformative defaults. The full Agent Card and canonical runtime identity SHALL remain available internally for validation and routing. `p2p_send` SHALL resolve a selected target only through that same production discovery boundary.

#### Scenario: The local runtime is identified and excluded
- **WHEN** the current room contains the active runtime's Agent Card and two remote live peers
- **THEN** `p2p_peers` identifies the local display and published target as `self` / `You` and lists only the two remote peers

#### Scenario: Self identity uses the canonical runtime ID
- **WHEN** a remote peer has the same display name or published-name base as the local runtime
- **THEN** self filtering compares full canonical runtime IDs and does not remove or classify the remote peer as self based on names

#### Scenario: Normal peer output is compact and routing-oriented
- **WHEN** a unique remote peer is idle with no queued work and has no model identity
- **THEN** the result includes its display name, published target, and idle state while omitting endpoint paths, endpoint runtime IDs, capabilities, lease fields, null values, and zero/default queue fields

#### Scenario: Busy peer load is meaningful
- **WHEN** a remote peer is busy with a non-zero inbound queue depth
- **THEN** the result includes its busy state and queue depth and does not include unrelated Agent Card transport or protocol metadata

#### Scenario: A displayed target can be sent
- **WHEN** `p2p_peers` displays a unique peer's published target and the model passes that value to `p2p_send`
- **THEN** the existing resolver finds the same peer and the router receives that peer's full canonical runtime ID

#### Scenario: Duplicate peer names retain disambiguation identity
- **WHEN** two valid live peers in the current room share a display or lookup base name
- **THEN** `p2p_peers` exposes enough full runtime identity to disambiguate them, and `p2p_send` does not route by the ambiguous name

#### Scenario: Full runtime routing remains supported
- **WHEN** `p2p_send` receives a uniquely found full runtime identity in the current room
- **THEN** it passes that identity to the router request API

#### Scenario: Many-peer output avoids Agent Card scaling
- **WHEN** a room contains many live peers with default metadata
- **THEN** normal `p2p_peers` output is materially smaller than the equivalent full Agent Card-derived pretty-printed JSON and contains no repeated endpoint or capability blocks
