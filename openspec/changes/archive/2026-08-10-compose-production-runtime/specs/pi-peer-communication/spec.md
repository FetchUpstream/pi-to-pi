## MODIFIED Requirements

### Requirement: Pi SHALL expose explicit peer communication tools
The default extension SHALL register `p2p_peers`, `p2p_send`, `p2p_reply`, and `p2p_status` as communication-only tools through a stable runtime-aware dispatcher. The dispatcher SHALL use only the current self-composed production Pi adapter and SHALL return a normal tool error when no active runtime exists. It SHALL NOT expose `p2p_await` in v1 or introduce orchestration, role, worktree, or agent-spawning semantics in tool descriptions or prompt guidance.

#### Scenario: A peer answer is asynchronous
- **WHEN** `p2p_send` admits a request that expects a response
- **THEN** the tool returns after admission and does not wait for the terminal peer reply

#### Scenario: Tools are available without adapter injection
- **WHEN** an installed default extension starts a Pi session without an injected adapter
- **THEN** all four communication tools dispatch to that session's current production runtime

## ADDED Requirements

### Requirement: Pi delivery SHALL be fenced to its originating runtime generation
The adapter and task executor SHALL capture the generation, session, and runtime that own inbound delivery and outbound completion callbacks. They SHALL deliver a terminal follow-up only when that exact generation remains active, and SHALL drop callbacks from replaced runtimes.

#### Scenario: Old completion resolves after replacement
- **WHEN** an old runtime's request completion resolves after reload, new, resume, fork, or clone creates a replacement runtime
- **THEN** no result custom message is injected into the replacement Pi session
