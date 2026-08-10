## MODIFIED Requirements

### Requirement: The default extension SHALL compose one production runtime per active Pi runtime
The normal default export SHALL register the four Pi-to-Pi communication tools and `p2p_report_issue` without requiring callers to construct or inject a `PiAdapter`, `MessageRouter`, `AgentCardRegistry`, `LocalIpcTransport`, diagnostic collector, or issue reporter. On `session_start`, it SHALL create one runtime-scoped composition owning the canonical session/runtime identity, room, generated endpoint, bound `LocalIpcTransport`, `AgentCardRegistry`, `MessageRouter`, `PiAdapter`, diagnostic event buffer, issue-reporting service, and immutable generation. The extension factory SHALL not allocate these resources.

#### Scenario: Default extension starts without injected components
- **WHEN** the extension is registered through its default export and Pi emits `session_start`
- **THEN** it exposes `p2p_peers`, `p2p_send`, `p2p_reply`, `p2p_status`, and `p2p_report_issue` and creates a current production runtime without externally supplied components

## ADDED Requirements

### Requirement: Reporting dependencies SHALL be isolated from communication correctness
The composition SHALL provide runtime-local diagnostic and reporting dependencies to the Pi adapter while preserving the router, discovery, and transport production path. Failures while recording diagnostics, checking reporter availability, searching duplicates, or creating an issue SHALL NOT block, retry, mutate, or terminalize Pi-to-Pi requests.

#### Scenario: GitHub is unreachable during reporting
- **WHEN** a model invokes `p2p_report_issue` while the GitHub reporter fails
- **THEN** the tool receives its bounded reporter outcome and active router, discovery, and transport state remain unchanged

#### Scenario: Runtime is replaced
- **WHEN** reload or session replacement creates a new production composition
- **THEN** the old diagnostic event buffer and reporter context are not reused by the replacement runtime
