## Purpose

Define the production lifecycle composition that joins local IPC, discovery, routing, and Pi adaptation.

## Requirements

### Requirement: The default extension SHALL compose one production runtime per active Pi runtime
The normal default export SHALL register the four Pi-to-Pi communication tools and `p2p_report_issue` without requiring callers to construct or inject a `PiAdapter`, `MessageRouter`, `AgentCardRegistry`, `LocalIpcTransport`, diagnostic collector, or issue reporter. On `session_start`, it SHALL create one runtime-scoped composition owning the canonical session/runtime identity, room, generated endpoint, bound `LocalIpcTransport`, `AgentCardRegistry`, `MessageRouter`, `PiAdapter`, diagnostic event buffer, issue-reporting service, and immutable generation. The extension factory SHALL not allocate these resources.

#### Scenario: Default extension starts without injected components
- **WHEN** the extension is registered through its default export and Pi emits `session_start`
- **THEN** it exposes `p2p_peers`, `p2p_send`, `p2p_reply`, `p2p_status`, and `p2p_report_issue` and creates a current production runtime without externally supplied components

### Requirement: A runtime SHALL bind transport before publishing discovery
The composition SHALL generate a production native endpoint, bind an inbound handler, construct its ready router and adapter, and only then start Agent Card publication. It SHALL NOT use `unbound:<runtimeId>` in the production path.

#### Scenario: Peer becomes discoverable only when callable
- **WHEN** a production runtime starts successfully
- **THEN** its published Agent Card endpoint is bound to an active handler before discovery returns that card

### Requirement: The composition SHALL bridge protocol operations over local IPC
The composition SHALL encode protocol envelopes and operation responses as bounded UTF-8 JSON above the opaque local IPC frame transport. Its outbound delivery SHALL resolve the exact live Agent Card recipient endpoint, request it, decode the returned operation response, call the originating router's `processResponse`, and report delivered only after that handoff succeeds. Its inbound handler SHALL decode an envelope, establish an authenticated same-room binding from live discovery, call `processInbound`, and return the correlated encoded operation response on the same request connection.

#### Scenario: IPC acknowledgement resolves a pending router operation
- **WHEN** an outbound router operation receives a valid synchronous IPC operation response
- **THEN** the originating router processes that response and its pending admission or control operation resolves

#### Scenario: Malformed transport protocol data is bounded
- **WHEN** an IPC request or response contains malformed JSON, an invalid protocol value, or exceeds the effective limit
- **THEN** the exchange fails with a bounded protocol failure and does not crash the transport server or leave a local pending operation unresolved indefinitely

### Requirement: The composition SHALL validate local discovery binding before routing
Before the router exposes task or deduplication state, the inbound bridge SHALL verify that the claimed sender has a valid unexpired Agent Card in the current exact room, that runtime/session identities and endpoint runtime identity agree with the envelope, and that the local runtime and room are current. It SHALL pass this identity through the router binding authentication seam and SHALL not add secrets or credentials to Agent Cards.

#### Scenario: Stale or cross-room sender is rejected
- **WHEN** an inbound envelope claims a missing, stale, mismatched, or cross-room sender runtime
- **THEN** the bridge rejects it before router task or deduplication disclosure

### Requirement: Reporting dependencies SHALL be isolated from communication correctness
The composition SHALL provide runtime-local diagnostic and reporting dependencies to the Pi adapter while preserving the router, discovery, and transport production path. Failures while recording diagnostics, checking reporter availability, searching duplicates, or creating an issue SHALL NOT block, retry, mutate, or terminalize Pi-to-Pi requests.

#### Scenario: GitHub is unreachable during reporting
- **WHEN** a model invokes `p2p_report_issue` while the GitHub reporter fails
- **THEN** the tool receives its bounded reporter outcome and active router, discovery, and transport state remain unchanged

#### Scenario: Runtime is replaced
- **WHEN** reload or session replacement creates a new production composition
- **THEN** the old diagnostic event buffer and reporter context are not reused by the replacement runtime
