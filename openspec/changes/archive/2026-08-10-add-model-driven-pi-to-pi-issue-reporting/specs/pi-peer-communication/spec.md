## MODIFIED Requirements

### Requirement: Pi SHALL expose explicit peer communication tools
The default extension SHALL register `p2p_peers`, `p2p_send`, `p2p_reply`, `p2p_status`, and `p2p_report_issue` through a stable runtime-aware dispatcher. The dispatcher SHALL use only the current self-composed production Pi adapter and SHALL return a normal tool error when no active runtime exists. It SHALL NOT expose `p2p_await` in v1 or introduce orchestration, role, worktree, or agent-spawning semantics in tool descriptions or prompt guidance.

#### Scenario: A peer answer is asynchronous
- **WHEN** `p2p_send` admits a request that expects a response
- **THEN** the tool returns after admission and does not wait for the terminal peer reply

## ADDED Requirements

### Requirement: Pi SHALL scope issue reporting to suspected Pi-to-Pi defects
`p2p_report_issue` SHALL instruct the model to use it only for suspected discovery, transport, routing/correlation, request/reply lifecycle, duplicate execution, stale runtime/lease, protocol validation, or Pi-to-Pi lifecycle/reload defects. It SHALL instruct the model not to use it for application failures, unrelated tool failures, model-quality complaints, feature requests, or arbitrary GitHub issue creation.

#### Scenario: An application test fails
- **WHEN** the model observes a failure that does not indicate incorrect Pi-to-Pi behavior
- **THEN** tool guidance does not direct the model to use `p2p_report_issue`

### Requirement: Pi SHALL return structured issue-reporting outcomes
The tool SHALL accept a bounded title, description, optional expected/actual observations, optional operation, and optional Pi-to-Pi correlation identifiers. It SHALL render the reporter's created, existing, unavailable, or failed outcome without exposing credentials, command output, or automatic diagnostic values outside the approved report result.

#### Scenario: Reporter reuses an existing issue
- **WHEN** the reporter returns an existing issue result
- **THEN** the tool identifies the existing issue number and URL as reused rather than reporting a new issue creation
